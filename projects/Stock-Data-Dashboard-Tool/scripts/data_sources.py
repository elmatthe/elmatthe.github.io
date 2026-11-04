"""Market data sources: your ordered source list (Yahoo Finance through the site's data
gateway, no key; Alpha Vantage, Marketstack or Alpaca with your own key) through the
shared market_data package, or your own CSV files.

The `yfinance` library is not used: Yahoo Finance is reached only through the site's
data gateway, which spaces and caches requests. Every price series records the source
it came from, the sources tried or skipped before it, its symbol and its price basis.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import pandas as pd

from config import get_files_dir
from market_data.errors import DataError
from market_data.history import boc_history, history_by_sources
from market_data.sources import describe_skipped, short_failure

MARKET_SOURCE = "Market data (your source list)"


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
    source: Optional[str] = None  # the source the series came from
    tried: list[str] = field(default_factory=list)  # sources that failed first, with the reason
    skipped: list[str] = field(default_factory=list)  # sources not asked, with the reason


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

# Last-resort guess used only when Yahoo reports no currency at all; the guess is
# reported as a warning. London (.L) is deliberately absent: its listings may be
# quoted in pence, pounds or US dollars, so no single guess is safe.
TICKER_SUFFIX_CURRENCY_MAP = {
    ".TO": "CAD",
    ".V": "CAD",
    ".NE": "CAD",
    ".CN": "CAD",
    ".AX": "AUD",
}


def normalize_ticker_symbol(ticker: str) -> str:
    return str(ticker).strip().upper()


def normalize_currency(value: object) -> str:
    return str(value).strip().upper()


# Listing currencies quoted in 1/100 of the ISO currency (Yahoo reports London
# listings as "GBp"/"GBX", Johannesburg as "ZAc", Tel Aviv as "ILA").
MINOR_UNIT_CURRENCIES = {"GBp": ("GBP", 0.01), "GBX": ("GBP", 0.01), "ZAc": ("ZAR", 0.01), "ZAC": ("ZAR", 0.01), "ILA": ("ILS", 0.01)}


def convert_minor_units(frame: pd.DataFrame, currency: str | None, ticker: str) -> tuple[pd.DataFrame, str | None, list[str]]:
    """Convert minor-unit prices (e.g. pence) to the major currency.

    Returns (frame, currency, warnings). Without this, a London price of 412 GBp
    would be labelled 412 GBP: 100 times too large in levels, exports and FX
    normalization (returns are unaffected because the scale cancels).
    """
    raw = str(currency).strip() if currency else ""
    if raw not in MINOR_UNIT_CURRENCIES:
        return frame, currency, []
    major, factor = MINOR_UNIT_CURRENCIES[raw]
    converted = frame.copy()
    for column in ("Close", "Adj Close"):
        if column in converted.columns:
            converted[column] = pd.to_numeric(converted[column], errors="coerce") * factor
    if "Currency" in converted.columns:
        converted["Currency"] = major
    return converted, major, [f"{ticker}: prices quoted in {raw} (1/100 {major}) were converted to {major}."]


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
        duplicated = combined.index[combined.index.duplicated()]
        if len(duplicated):
            raise DataSourceError(f"{ticker}: the CSV files contain more than one row for {', '.join(sorted({d.date().isoformat() for d in duplicated})[:5])}. "
                                  "Keep one price per date (a duplicate row creates a false return).")
        for column in ("Close", "Adj Close"):
            bad = combined.index[pd.to_numeric(combined[column], errors="coerce") <= 0]
            if len(bad):
                raise DataSourceError(f"{ticker}: {column} is zero or negative on {', '.join(d.date().isoformat() for d in bad[:5])}. Prices must be greater than 0.")
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


def _resample_prices(frame: pd.DataFrame, frequency: str, today: dt.date | None = None) -> pd.DataFrame:
    """Weekly or monthly bars: the LAST trading day of each completed period.

    Each bar is dated by its actual last trading date (not a future Friday or month
    end), and the current week or month is dropped while it may still be trading (D3).
    """
    normalized = frequency.strip().lower()
    if normalized not in ("weekly", "monthly") or frame.empty:
        return frame
    today = today or dt.date.today()
    data = frame.sort_index()
    period_end = data.index.to_series().dt.to_period("W-FRI" if normalized == "weekly" else "M").dt.end_time.dt.normalize()
    last_rows = data.groupby(period_end.values).tail(1)
    ends = period_end.loc[last_rows.index]
    complete = ends.dt.date < today
    return last_rows[complete.values].dropna(how="all")


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
            raw_values = [str(v).strip() for v in frame["Currency"].dropna() if str(v).strip()]
            if raw_values and all(v in ("GBp", "GBX") for v in raw_values):
                frame, _, unit_warnings = convert_minor_units(frame, raw_values[0], ticker_key)
                warnings.extend(unit_warnings)
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


class SourceListHistorySource(BaseDataSource):
    """Daily history from the first source in the user's list that can give it."""

    name = MARKET_SOURCE

    def __init__(self, market) -> None:
        self.md = market

    def is_configured(self) -> bool:
        return self.md.has_price_source("history")

    def validate_ticker(self, ticker: str) -> TickerValidationResult:
        identity = self.md.resolve(ticker)
        ok = identity["status"] == "resolved"
        return TickerValidationResult(identity["displayTicker"], ok, identity.get("currency") if ok else None, None if ok else identity.get("reason"))

    def fetch_prices(self, ticker: str, start_date: str, end_date: str, price_type: str, frequency: str) -> PriceDataResult:
        identity = self.md.resolve(ticker)
        if identity["status"] != "resolved":
            if identity.get("instrumentType") == "index":
                raise DataSourceError(f"{identity['displayTicker']}: market indexes are not available from these sources (they serve stocks, ETFs and funds). Use an index ETF, or Offline CSV.")
            raise DataSourceError(f"{identity['displayTicker']}: {identity.get('reason')}")
        try:
            h = history_by_sources(self.md, identity, start_date, end_date, analysis_frequency=frequency)
        except DataError as exc:
            details = "; ".join(f"{a['provider']}: {a['message']}" for a in getattr(exc, "attempts", []) or [])
            raise DataSourceError(f"{identity['displayTicker']}: {exc.message}{f' Details: {details}' if details else ''}") from exc
        if not h["observations"]:
            raise DataSourceError(f"{identity['displayTicker']}: no prices in the selected window.")
        frame = pd.DataFrame(h["observations"], columns=["Date", "Close", "Adj Close"]).set_index("Date")
        frame.index = pd.to_datetime(frame.index)
        tried = [f"{a['provider']}: {short_failure(a)}" for a in h["attempts"]]
        skipped = describe_skipped(h["skipped"])
        warnings = [f"{identity['displayTicker']}: from {h['sourceName']}. {h['basisNote']}"]
        if tried:
            warnings.append(f"{identity['displayTicker']}: {h['sourceName']} was used because {'; '.join(tried)}.")
        if _canonical_price_column(price_type) == "Adj Close" and not h["hasAdjusted"]:
            frame["Adj Close"] = frame["Close"]
            warnings.append(f"{identity['displayTicker']}: adjusted closes are not available from {h['provider']} for this window; plain closes (price return) are used.")
        frame = frame.dropna(how="all")
        frame = _resample_prices(frame, frequency)
        if identity.get("listedFrom") and start_date < identity["listedFrom"]:
            warnings.append(f"{identity['displayTicker']}: listed only since {identity['listedFrom']}; earlier history under this symbol belongs to a different security and is not used.")
            frame = frame.loc[pd.to_datetime(identity["listedFrom"]):]
        currency = h["currency"] if h["currencyVerified"] else None
        if currency:
            frame["Currency"] = currency
        return PriceDataResult(identity["displayTicker"], identity.get("name") or identity["displayTicker"], currency, frame, warnings,
                               source=h["sourceName"], tried=tried, skipped=skipped)

    def fetch_fx_rate(self, from_currency: str, to_currency: str, start_date: str, end_date: str, frequency: str) -> Optional[pd.Series]:
        """`to` units per one `from` unit, from Bank of Canada daily averages (derived through CAD)."""
        from_code, to_code = normalize_currency(from_currency), normalize_currency(to_currency)
        if not from_code or not to_code or from_code == to_code:
            return None
        try:
            hist = boc_history(self.md, [from_code, to_code], start_date, end_date)
        except DataError:
            return None
        def cad_per(code: str) -> pd.Series:
            if code == "CAD":
                return pd.Series(1.0, index=pd.to_datetime(sorted({d for v in hist.values() for d, _ in v})))
            return pd.Series({pd.Timestamp(d): v for d, v in hist.get(code, [])}).sort_index()
        a, b = cad_per(from_code), cad_per(to_code)
        rate = (a / b).dropna()
        return rate if not rate.empty else None


def get_data_source(name: str, offline_folder: str | None = None, market=None) -> BaseDataSource:
    """Offline CSV, or market data from the user's ordered source list."""
    if name == OfflineCsvSource.name:
        return OfflineCsvSource(offline_folder)
    if name == MARKET_SOURCE:
        return SourceListHistorySource(market)
    raise DataSourceError(f"Unknown data source: {name}")
