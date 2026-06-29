"""Market data provider implementations."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import pandas as pd

try:
    import yfinance as yf
except ImportError:  # pragma: no cover - exercised when dependencies are absent.
    yf = None

from config import get_files_dir, load_config


class DataSourceError(Exception):
    """Raised when a data source cannot return usable prices."""


@dataclass
class TickerValidationResult:
    ticker: str
    is_valid: bool
    detected_currency: Optional[str] = None
    warning: Optional[str] = None


@dataclass
class PriceDataResult:
    ticker: str
    display_name: Optional[str]
    currency: Optional[str]
    prices: pd.DataFrame
    warnings: list[str] = field(default_factory=list)


class BaseDataSource:
    name = "Base"

    def is_configured(self) -> bool:
        return True

    def validate_ticker(self, ticker: str) -> TickerValidationResult:
        return TickerValidationResult(ticker=ticker.strip().upper(), is_valid=bool(ticker.strip()))

    def fetch_prices(
        self,
        ticker: str,
        start_date: str,
        end_date: str,
        price_type: str,
        frequency: str,
    ) -> PriceDataResult:
        raise NotImplementedError

    def fetch_fx_rate(
        self,
        from_currency: str,
        to_currency: str,
        start_date: str,
        end_date: str,
        frequency: str,
    ) -> Optional[pd.Series]:
        """Return a daily FX-rate series of `to` units per one `from` unit.

        Returns None when this source cannot provide FX rates so callers can
        fail soft and keep native-currency behaviour.
        """
        return None


OFFLINE_FOLDER_HELP = (
    "Expected either:\n"
    "1. A combined CSV with columns Date, Ticker, Close, Adj Close, Currency\n"
    "2. One CSV per ticker named like AAPL.csv, MSFT.csv, XIU.TO.csv"
)

PRICE_COLUMN_ALIASES = {
    "Close": ["Close", "close"],
    "Adj Close": ["Adjusted Close", "Adj Close", "adjusted close", "adj close", "adj_close"],
}

TICKER_SUFFIX_CURRENCY_MAP = {
    ".TO": "CAD",
    ".V": "CAD",
    ".NE": "CAD",
    ".CN": "CAD",
    ".L": "GBP",
    ".AX": "AUD",
}


def normalize_ticker_symbol(ticker: str) -> str:
    return str(ticker).strip().upper()


def normalize_currency(value: object) -> str:
    return str(value).strip().upper()


def _most_common_currency(values: pd.Series) -> tuple[str | None, list[str]]:
    currencies = [normalize_currency(value) for value in values.dropna() if normalize_currency(value)]
    if not currencies:
        return None, []
    counts = pd.Series(currencies).value_counts()
    currency = str(counts.index[0])
    warnings = []
    if len(counts) > 1:
        warnings.append(f"Multiple currency values were found for this ticker in Offline CSV data. Using most common value: {currency}.")
    return currency, warnings


def _canonical_price_column(price_type: str) -> str:
    return "Adj Close" if price_type.lower().startswith("adjust") else "Close"


def _rename_price_aliases(frame: pd.DataFrame) -> pd.DataFrame:
    renamed = frame.copy()
    normalized_lookup = {str(column).strip().lower(): column for column in renamed.columns}
    for canonical, aliases in PRICE_COLUMN_ALIASES.items():
        for alias in aliases:
            source = normalized_lookup.get(alias.lower())
            if source is not None and source != canonical:
                renamed = renamed.rename(columns={source: canonical})
                normalized_lookup[canonical.lower()] = canonical
                break
    return renamed


def normalize_price_frame(df: pd.DataFrame, ticker: str) -> pd.DataFrame:
    frame = _rename_price_aliases(df)
    frame.columns = [str(column).strip() for column in frame.columns]
    if "Date" in frame.columns:
        frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce")
        frame = frame.dropna(subset=["Date"]).set_index("Date")
    else:
        parsed_index = pd.to_datetime(frame.index, errors="coerce")
        if parsed_index.isna().all():
            raise DataSourceError(f"{ticker} CSV is missing a Date column. {OFFLINE_FOLDER_HELP}")
        frame.index = parsed_index
        frame = frame[frame.index.notna()]

    warnings = []
    had_adj_close = "Adj Close" in frame.columns
    for column in ("Close", "Adj Close"):
        if column in frame.columns:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
    if "Close" not in frame.columns and "Adj Close" in frame.columns:
        frame["Close"] = frame["Adj Close"]
    if "Adj Close" not in frame.columns and "Close" in frame.columns:
        frame["Adj Close"] = frame["Close"]
        if not had_adj_close:
            warnings.append(f"{normalize_ticker_symbol(ticker)} CSV does not include Adjusted Close. Falling back to Close.")
    if "Close" not in frame.columns:
        raise DataSourceError(f"{ticker} CSV is missing a Close or Adjusted Close price column. {OFFLINE_FOLDER_HELP}")
    if "Ticker" not in frame.columns:
        frame["Ticker"] = normalize_ticker_symbol(ticker)
    else:
        frame["Ticker"] = frame["Ticker"].fillna(ticker).map(normalize_ticker_symbol)
    if "Currency" not in frame.columns:
        frame["Currency"] = ""
    frame = frame.sort_index()
    frame.index.name = "Date"
    result = frame[["Ticker", "Close", "Adj Close", "Currency"]]
    result.attrs["warnings"] = warnings
    return result


def load_offline_csv_folder(folder_path: str) -> dict[str, pd.DataFrame]:
    folder = Path(folder_path)
    if not folder.exists() or not folder.is_dir():
        raise DataSourceError(f"Offline CSV folder does not exist: {folder}\n\n{OFFLINE_FOLDER_HELP}")

    csv_files = sorted(file for file in folder.glob("*.csv") if file.name.lower() not in FX_RATES_FILENAMES)
    if not csv_files:
        raise DataSourceError(f"No CSV files were found in the selected Offline CSV folder: {folder}\n\n{OFFLINE_FOLDER_HELP}")

    frames_by_ticker: dict[str, list[pd.DataFrame]] = {}
    for csv_file in csv_files:
        raw = pd.read_csv(csv_file)
        inferred_ticker = normalize_ticker_symbol(csv_file.stem)
        normalized = normalize_price_frame(raw, inferred_ticker)
        for ticker, ticker_frame in normalized.groupby("Ticker", dropna=False):
            ticker_key = normalize_ticker_symbol(ticker)
            part = ticker_frame.drop(columns=["Ticker"])
            part.attrs["warnings"] = list(normalized.attrs.get("warnings", []))
            frames_by_ticker.setdefault(ticker_key, []).append(part)

    result = {}
    for ticker, parts in frames_by_ticker.items():
        combined = pd.concat(parts).sort_index()[["Close", "Adj Close", "Currency"]]
        warnings = []
        for part in parts:
            warnings.extend(part.attrs.get("warnings", []))
        combined.attrs["warnings"] = warnings
        result[ticker] = combined
    return result


FX_RATES_FILENAMES = ("fx_rates.csv", "sample_fx_rates.csv")


def load_offline_fx_rates(folder_path: str) -> dict[str, pd.Series]:
    """Load bundled FX rates from an offline folder, if present.

    Expected format: columns Date, Pair, Rate where Pair is a 6-letter
    `<FROM><TO>` code and Rate is `TO` units per one `FROM` unit, e.g.
    `2024-01-02,CADUSD,0.75`. Returns {pair: Series indexed by date}. Missing
    file returns an empty mapping (callers fail soft).
    """
    folder = Path(folder_path) if folder_path else None
    if not folder or not folder.is_dir():
        return {}
    fx_file = None
    for name in FX_RATES_FILENAMES:
        candidate = folder / name
        if candidate.exists():
            fx_file = candidate
            break
    if fx_file is None:
        return {}
    raw = pd.read_csv(fx_file)
    columns = {str(col).strip().lower(): col for col in raw.columns}
    if not {"date", "pair", "rate"}.issubset(columns):
        return {}
    rates: dict[str, pd.Series] = {}
    for pair, group in raw.groupby(columns["pair"]):
        key = normalize_currency(pair)
        series = pd.Series(
            pd.to_numeric(group[columns["rate"]], errors="coerce").to_numpy(),
            index=pd.to_datetime(group[columns["date"]], errors="coerce"),
        ).dropna().sort_index()
        if not series.empty:
            rates[key] = series
    return rates


def get_offline_fx_rate(rates: dict[str, pd.Series], from_currency: str, to_currency: str) -> Optional[pd.Series]:
    """Resolve a `from`->`to` rate from a loaded FX map, deriving the inverse."""
    from_code = normalize_currency(from_currency)
    to_code = normalize_currency(to_currency)
    if from_code == to_code:
        return None
    direct = rates.get(f"{from_code}{to_code}")
    if direct is not None and not direct.empty:
        return direct
    inverse = rates.get(f"{to_code}{from_code}")
    if inverse is not None and not inverse.empty:
        return 1.0 / inverse
    return None


def _resample_prices(frame: pd.DataFrame, frequency: str) -> pd.DataFrame:
    normalized = frequency.strip().lower()
    if normalized == "weekly":
        return frame.resample("W-FRI").last().dropna(how="all")
    if normalized == "monthly":
        return frame.resample("ME").last().dropna(how="all")
    return frame


class OfflineCsvSource(BaseDataSource):
    name = "Offline CSV"

    def __init__(self, folder_path: str | None = None):
        self.folder_path = folder_path
        self._cache: dict[str, pd.DataFrame] | None = None

    def is_configured(self) -> bool:
        return bool(self.folder_path)

    def _load(self) -> dict[str, pd.DataFrame]:
        if self._cache is None:
            if not self.folder_path:
                raise DataSourceError("Choose an offline CSV folder before fetching data.")
            self._cache = load_offline_csv_folder(self.folder_path)
        return self._cache

    def validate_ticker(self, ticker: str) -> TickerValidationResult:
        ticker_key = normalize_ticker_symbol(ticker)
        try:
            data = self._load()
        except DataSourceError as exc:
            return TickerValidationResult(ticker_key, False, warning=str(exc))
        is_valid = ticker_key in data
        currency = None
        if is_valid and "Currency" in data[ticker_key].columns:
            currency, _warnings = _most_common_currency(data[ticker_key]["Currency"])
        return TickerValidationResult(ticker_key, is_valid, currency, None if is_valid else f"{ticker_key} not found in offline CSV files.")

    def fetch_prices(
        self,
        ticker: str,
        start_date: str,
        end_date: str,
        price_type: str,
        frequency: str,
    ) -> PriceDataResult:
        ticker_key = normalize_ticker_symbol(ticker)
        data = self._load()
        if ticker_key not in data:
            available = ", ".join(sorted(data)) or "none"
            raise DataSourceError(
                f"{ticker_key} was not found in the selected Offline CSV folder.\n\n"
                "Check that the combined CSV contains a Ticker column or that one-file-per-ticker CSVs are named like AAPL.csv, MSFT.csv, XIU.TO.csv.\n\n"
                f"Available tickers: {available}"
            )
        frame = data[ticker_key].copy()
        warnings = list(data[ticker_key].attrs.get("warnings", []))
        available_start = frame.index.min()
        available_end = frame.index.max()
        selected_start = pd.to_datetime(start_date)
        selected_end = pd.to_datetime(end_date)
        frame = frame.loc[selected_start:selected_end]
        if frame.empty:
            raise DataSourceError(
                f"{ticker_key} exists in the Offline CSV data, but no rows overlap the selected date range.\n\n"
                f"Selected range: {selected_start.date()} to {selected_end.date()}\n"
                f"Available range: {available_start.date()} to {available_end.date()}"
            )
        frame = _resample_prices(frame, frequency)
        price_column = _canonical_price_column(price_type)
        if price_column not in frame.columns or frame[price_column].dropna().empty:
            if price_column == "Adj Close" and "Close" in frame.columns and not frame["Close"].dropna().empty:
                frame["Adj Close"] = frame["Close"]
                warnings.append(f"{ticker_key}: Adjusted Close was requested but not available. Falling back to Close.")
            else:
                raise DataSourceError(f"{ticker_key} is missing usable values for requested price type: {price_type}.")
        currency = None
        if "Currency" in frame.columns:
            currency, currency_warnings = _most_common_currency(frame["Currency"])
            warnings.extend([f"{ticker_key}: {warning}" for warning in currency_warnings])
        return PriceDataResult(ticker_key, ticker_key, currency, frame, warnings)

    def fetch_fx_rate(
        self,
        from_currency: str,
        to_currency: str,
        start_date: str,
        end_date: str,
        frequency: str,
    ) -> Optional[pd.Series]:
        rates = load_offline_fx_rates(self.folder_path or "")
        return get_offline_fx_rate(rates, from_currency, to_currency)


class YahooFinanceSource(BaseDataSource):
    name = "Yahoo Finance"

    def __init__(self) -> None:
        if yf is not None:
            cache_dir = get_files_dir() / "cache" / "yfinance"
            cache_dir.mkdir(parents=True, exist_ok=True)
            yf.set_tz_cache_location(str(cache_dir))

    def is_configured(self) -> bool:
        return yf is not None

    def validate_ticker(self, ticker: str) -> TickerValidationResult:
        ticker_key = ticker.strip().upper()
        return TickerValidationResult(ticker=ticker_key, is_valid=bool(ticker_key))

    def fetch_prices(
        self,
        ticker: str,
        start_date: str,
        end_date: str,
        price_type: str,
        frequency: str,
    ) -> PriceDataResult:
        if yf is None:
            raise DataSourceError("yfinance is not installed.")
        ticker_key = ticker.strip().upper()
        try:
            ticker_obj = yf.Ticker(ticker_key)
            history = ticker_obj.history(start=start_date, end=end_date, auto_adjust=False, actions=False)
        except Exception as exc:
            raise DataSourceError(f"No usable data was returned for {ticker_key}. {exc}") from exc

        if history.empty:
            raise DataSourceError(f"No usable data was returned for {ticker_key}.")

        frame = history.rename(columns={"Adj Close": "Adj Close"})[["Close", "Adj Close"]].copy()
        frame.index = pd.to_datetime(frame.index).tz_localize(None)
        frame = _resample_prices(frame, frequency)
        currency = None
        try:
            fast_info = ticker_obj.fast_info
            if hasattr(fast_info, "get"):
                currency = fast_info.get("currency")
            if not currency:
                currency = getattr(fast_info, "currency", None)
        except Exception:
            currency = None

        info = {}
        try:
            info = ticker_obj.get_info()
        except Exception:
            info = {}
        currency = currency or info.get("currency")
        if not currency:
            for suffix, suffix_currency in TICKER_SUFFIX_CURRENCY_MAP.items():
                if ticker_key.endswith(suffix):
                    currency = suffix_currency
                    break
        currency = normalize_currency(currency) if currency else None
        display_name = info.get("shortName") or info.get("longName") or ticker_key
        if currency:
            frame["Currency"] = currency
        if _canonical_price_column(price_type) not in frame.columns or frame[_canonical_price_column(price_type)].dropna().empty:
            raise DataSourceError(f"No usable data was returned for {ticker_key}.")
        return PriceDataResult(ticker_key, display_name, currency, frame, [])

    def fetch_fx_rate(
        self,
        from_currency: str,
        to_currency: str,
        start_date: str,
        end_date: str,
        frequency: str,
    ) -> Optional[pd.Series]:
        if yf is None:
            return None
        from_code = normalize_currency(from_currency)
        to_code = normalize_currency(to_currency)
        if not from_code or not to_code or from_code == to_code:
            return None
        # Yahoo exposes FX as `<FROM><TO>=X`, quoting TO units per one FROM unit.
        symbol = f"{from_code}{to_code}=X"
        try:
            history = yf.Ticker(symbol).history(start=start_date, end=end_date, auto_adjust=False, actions=False)
        except Exception:
            return None
        if history is None or history.empty or "Close" not in history.columns:
            return None
        rate = pd.to_numeric(history["Close"], errors="coerce").dropna()
        if rate.empty:
            return None
        rate.index = pd.to_datetime(rate.index).tz_localize(None)
        rate = _resample_prices(rate.to_frame("Close"), frequency)["Close"]
        return rate.dropna()


class AlphaVantageSource(BaseDataSource):
    name = "Alpha Vantage"

    def is_configured(self) -> bool:
        return bool(load_config().get("alpha_vantage_api_key"))

    def fetch_prices(self, *args, **kwargs) -> PriceDataResult:
        raise DataSourceError("Alpha Vantage support is a future enhancement. Set ALPHA_VANTAGE_API_KEY when implemented.")


class TwelveDataSource(BaseDataSource):
    name = "Twelve Data"

    def is_configured(self) -> bool:
        return bool(load_config().get("twelve_data_api_key"))

    def fetch_prices(self, *args, **kwargs) -> PriceDataResult:
        raise DataSourceError("Twelve Data support is a future enhancement. Set TWELVE_DATA_API_KEY when implemented.")


def get_data_source(name: str, offline_folder: str | None = None) -> BaseDataSource:
    sources = {
        YahooFinanceSource.name: YahooFinanceSource(),
        OfflineCsvSource.name: OfflineCsvSource(offline_folder),
        AlphaVantageSource.name: AlphaVantageSource(),
        TwelveDataSource.name: TwelveDataSource(),
    }
    return sources[name]
