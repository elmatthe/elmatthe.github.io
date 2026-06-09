from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from main import build_currency_mismatch_warnings, build_offline_csv_failure_summary, build_offline_csv_not_enough_data_message  # noqa: E402


def test_build_currency_mismatch_warnings_returns_only_mismatches():
    selected = {"AAPL": "CAD", "MSFT": "EUR", "XIU.TO": "CAD"}
    detected = {"AAPL": "USD", "MSFT": "USD", "XIU.TO": "CAD"}

    warnings = build_currency_mismatch_warnings(selected, detected)

    assert warnings == [
        "AAPL was entered as CAD, but the data source reports USD.",
        "MSFT was entered as EUR, but the data source reports USD.",
    ]


def test_build_currency_mismatch_warnings_ignores_missing_detected_currency():
    selected = {"AAPL": "CAD"}
    detected = {}

    assert build_currency_mismatch_warnings(selected, detected) == []


def test_offline_csv_not_enough_data_message_prioritizes_date_overlap_guidance():
    failures = {
        "AAPL": (
            "AAPL exists in the Offline CSV data, but no rows overlap the selected date range.\n\n"
            "Selected range: 2025-01-01 to 2026-06-09\n"
            "Available range: 2024-01-02 to 2024-01-04"
        ),
        "MSFT": (
            "MSFT exists in the Offline CSV data, but no rows overlap the selected date range.\n\n"
            "Selected range: 2025-01-01 to 2026-06-09\n"
            "Available range: 2024-01-02 to 2024-01-04"
        ),
        "XIU.TO": (
            "XIU.TO exists in the Offline CSV data, but no rows overlap the selected date range.\n\n"
            "Selected range: 2025-01-01 to 2026-06-09\n"
            "Available range: 2024-01-02 to 2024-01-04"
        ),
        "VEQT.TO": (
            "VEQT.TO was not found in the selected Offline CSV folder.\n\n"
            "Check that the combined CSV contains a Ticker column or that one-file-per-ticker CSVs are named like AAPL.csv, MSFT.csv, XIU.TO.csv.\n\n"
            "Available tickers: AAPL, MSFT, XIU.TO"
        ),
    }

    message = build_offline_csv_not_enough_data_message(failures)

    assert message.startswith("Offline CSV data was found")
    assert "selected date range does not overlap the CSV data" in message
    assert "Selected range: 2025-01-01 to 2026-06-09" in message
    assert "Available CSV date range: 2024-01-02 to 2024-01-04" in message
    assert "AAPL" in message
    assert "MSFT" in message
    assert "XIU.TO" in message
    assert "VEQT.TO" in message
    assert "use 2024-01-02 to 2024-01-04" in message
    assert "switch Data Source to Yahoo Finance" in message
    assert (
        "At least two valid securities are required for comparison, but the main issue appears to be that the selected date range does not overlap the Offline CSV data."
        in message
    )


def test_offline_csv_failure_summary_starts_with_date_mismatch_context():
    failures = {
        "AAPL": (
            "AAPL exists in the Offline CSV data, but no rows overlap the selected date range.\n\n"
            "Selected range: 2025-01-01 to 2026-06-09\n"
            "Available range: 2024-01-02 to 2024-01-04"
        ),
        "MSFT": (
            "MSFT exists in the Offline CSV data, but no rows overlap the selected date range.\n\n"
            "Selected range: 2025-01-01 to 2026-06-09\n"
            "Available range: 2024-01-02 to 2024-01-04"
        ),
        "XIU.TO": (
            "XIU.TO exists in the Offline CSV data, but no rows overlap the selected date range.\n\n"
            "Selected range: 2025-01-01 to 2026-06-09\n"
            "Available range: 2024-01-02 to 2024-01-04"
        ),
    }

    summary = build_offline_csv_failure_summary(failures)

    assert summary.startswith("Offline CSV date range mismatch detected.")
    assert "The requested tickers were found, but the selected date range does not overlap the CSV data." in summary
    assert "Use the CSV's available date range or switch to Yahoo Finance for live data." in summary
    assert "The following tickers exist in the Offline CSV data" in summary
    assert "AAPL" in summary
    assert "MSFT" in summary
    assert "XIU.TO" in summary
