"""Project configuration helpers."""

from __future__ import annotations

from pathlib import Path


SUPPORTED_CURRENCIES = ["USD", "CAD", "EUR", "GBP", "JPY", "AUD"]
COMMON_BASE_CURRENCY = None
FX_CONVERSION_ENABLED = False
DEFAULT_CURRENCY = "USD"
DEFAULT_RISK_FREE_RATE = 0.0
MAX_TICKERS = 20

# FX normalization. The selector lets the user convert every security's price
# series into one common currency before any metrics or charts are computed.
NORMALIZATION_OFF_LABEL = "Off (native listing currency)"
# Currencies offered for normalization. USD/CAD are the priority; EUR/GBP are
# supported because Yahoo Finance exposes those FX pairs cleanly as `<from><to>=X`.
NORMALIZE_CURRENCY_OPTIONS = [NORMALIZATION_OFF_LABEL, "USD", "CAD", "EUR", "GBP"]


def parse_normalization_choice(value: str | None) -> str | None:
    """Return the target currency code, or None when normalization is Off."""
    text = str(value or "").strip()
    if not text or text == NORMALIZATION_OFF_LABEL or text.lower().startswith("off"):
        return None
    return text.upper()

DAILY_PERIODS = 252
WEEKLY_PERIODS = 52
MONTHLY_PERIODS = 12


def get_project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def get_files_dir() -> Path:
    path = get_project_root() / "files"
    path.mkdir(parents=True, exist_ok=True)
    return path


def get_exports_dir() -> Path:
    path = get_files_dir() / "exports"
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_directory(path: str | Path) -> Path:
    directory = Path(path).expanduser()
    directory.mkdir(parents=True, exist_ok=True)
    if not directory.is_dir():
        raise ValueError(f"Path is not a directory: {directory}")
    test_file = directory / ".write_test"
    try:
        test_file.write_text("ok", encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"Directory is not writable: {directory}") from exc
    finally:
        try:
            test_file.unlink()
        except OSError:
            pass
    return directory


def get_plots_dir() -> Path:
    path = get_files_dir() / "plots"
    path.mkdir(parents=True, exist_ok=True)
    return path


def get_website_assets_dir() -> Path:
    path = get_files_dir() / "website-assets"
    path.mkdir(parents=True, exist_ok=True)
    return path


def get_periods_per_year(frequency: str) -> int:
    normalized = frequency.strip().lower()
    if normalized == "weekly":
        return WEEKLY_PERIODS
    if normalized == "monthly":
        return MONTHLY_PERIODS
    return DAILY_PERIODS
