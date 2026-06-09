"""Project configuration helpers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


SUPPORTED_CURRENCIES = ["USD", "CAD", "EUR", "GBP", "JPY", "AUD"]
COMMON_BASE_CURRENCY = None
FX_CONVERSION_ENABLED = False
DEFAULT_CURRENCY = "USD"
DEFAULT_RISK_FREE_RATE = 0.0
MAX_TICKERS = 20

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


def load_config() -> dict[str, Any]:
    config_path = get_project_root() / "config.json"
    config: dict[str, Any] = {}
    if config_path.exists():
        with config_path.open("r", encoding="utf-8") as handle:
            config = json.load(handle)

    env_map = {
        "alpha_vantage_api_key": "ALPHA_VANTAGE_API_KEY",
        "twelve_data_api_key": "TWELVE_DATA_API_KEY",
        "polygon_api_key": "POLYGON_API_KEY",
    }
    for key, env_name in env_map.items():
        config[key] = os.getenv(env_name, config.get(key, ""))

    config.setdefault("default_risk_free_rate", DEFAULT_RISK_FREE_RATE)
    config.setdefault("default_currency", DEFAULT_CURRENCY)
    return config


def get_periods_per_year(frequency: str) -> int:
    normalized = frequency.strip().lower()
    if normalized == "weekly":
        return WEEKLY_PERIODS
    if normalized == "monthly":
        return MONTHLY_PERIODS
    return DAILY_PERIODS
