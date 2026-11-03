// CPI_Downloader dataset contract: the nineteen A:S columns, in order, exactly as the
// desktop CPI Web Scraper writes them (projects/CPI-Webscraper/scripts/config-default.toml,
// cpi_config.SUPPORTED_IDS and data_sources.py). _tools/tests/test_cpi_parity.py checks
// every id, header, order, source identifier, aggregation and first month against the
// desktop files, and the FRED gateway's allowlist against `FRED_SERIES` below, so the
// browser cannot drift from the desktop application.
//
// To add or change a series safely: change the desktop downloader first (canonical
// repository elmatthe/CPI-Webscraper), then mirror it here and in the gateway allowlist
// (_services/cpi-data-gateway/src/gateway.js), then run the parity tests. The CSV
// contract (19 columns, these headers) must not change without an owner decision.

export const SCHEMA_VERSION = "cpi.dataset.v1";
export const MIN_MONTH = "1913-01"; // the downloader's earliest month (January 1913)

// kind: "monthly" = monthly observations as published (dated the 1st of the month);
//       "daily_eom" = a daily series reduced to its latest valid observation in each
//       calendar month, left blank for the current, unfinished month.
// firstMonth: the series' first published month, as the desktop checks it
//       (EXPECTED_STARTS); null for SP500, whose FRED history is a rolling ~10 years.
export const COLUMNS = Object.freeze([
  { col: "A", id: "date", header: "Date", source: "date", group: null, label: "Date", units: "First day of the month (YYYY-MM-DD)" },
  { col: "B", id: "ca_cpi_headline_nsa", header: "Headline CPI - Unadjusted CDN", source: "statcan", sourceId: "41690973", kind: "monthly", firstMonth: "1914-01", group: "canada", label: "Headline, NSA", units: "Index, 2002=100", decimals: 1 },
  { col: "C", id: "ca_cpi_headline_sa", header: "Headline CPI - Seasonally Adjusted CDN", source: "statcan", sourceId: "41690914", kind: "monthly", firstMonth: "1992-01", group: "canada", label: "Headline, SA", units: "Index, 2002=100", decimals: 1 },
  { col: "D", id: "ca_cpi_core_nsa", header: "Core CPI - Unadjusted CDN", source: "statcan", sourceId: "41691233", kind: "monthly", firstMonth: "1961-01", group: "canada", label: "Core, NSA", units: "Index, 2002=100 (all-items excluding food and energy)", decimals: 1 },
  { col: "E", id: "ca_cpi_core_sa", header: "Core CPI - Seasonally Adjusted CDN", source: "statcan", sourceId: "41690924", kind: "monthly", firstMonth: "1992-01", group: "canada", label: "Core, SA", units: "Index, 2002=100 (all-items excluding food and energy)", decimals: 1 },
  { col: "F", id: "ca_cpi_alberta_nsa", header: "Alberta CPI - Unadjusted CDN", source: "statcan", sourceId: "41692327", kind: "monthly", firstMonth: "1978-09", group: "canada", label: "Alberta, NSA", units: "Index, 2002=100", decimals: 1 },
  { col: "G", id: "us_cpi_headline_nsa", header: "Headline CPI - Unadjusted US", source: "fred", sourceId: "CPIAUCNS", kind: "monthly", firstMonth: "1913-01", group: "us_inflation", label: "CPI, NSA", units: "Index, 1982-1984=100", decimals: 3 },
  { col: "H", id: "us_cpi_headline_sa", header: "Headline CPI - Seasonally Adjusted US", source: "fred", sourceId: "CPIAUCSL", kind: "monthly", firstMonth: "1947-01", group: "us_inflation", label: "CPI, SA", units: "Index, 1982-1984=100", decimals: 3 },
  { col: "I", id: "us_cpi_core_nsa", header: "Core CPI - Unadjusted US", source: "fred", sourceId: "CPILFENS", kind: "monthly", firstMonth: "1957-01", group: "us_inflation", label: "Core CPI, NSA", units: "Index, 1982-1984=100 (less food and energy)", decimals: 3 },
  { col: "J", id: "us_cpi_core_sa", header: "Core CPI - Seasonally Adjusted US", source: "fred", sourceId: "CPILFESL", kind: "monthly", firstMonth: "1957-01", group: "us_inflation", label: "Core CPI, SA", units: "Index, 1982-1984=100 (less food and energy)", decimals: 3 },
  { col: "K", id: "us_unemployment_sa", header: "Unemployment Rate - Seasonally Adjusted US", source: "fred", sourceId: "UNRATE", kind: "monthly", firstMonth: "1948-01", group: "other", label: "Unemployment", units: "Percent, seasonally adjusted", decimals: 1 },
  { col: "L", id: "us_fed_funds_avg", header: "Monthly Effective Fed Fund Rate US", source: "fred", sourceId: "FEDFUNDS", kind: "monthly", firstMonth: "1954-07", group: "rates", label: "Fed funds, avg", units: "Percent, monthly average of daily rates", decimals: 2 },
  { col: "M", id: "us_fed_funds_eom", header: "Monthly Fed Fund Rate - EOP US", source: "fred", sourceId: "DFF", kind: "daily_eom", firstMonth: "1954-07", group: "rates", label: "Fed funds, EOP", units: "Percent, effective rate on the month's last observation", decimals: 2 },
  { col: "N", id: "us_sp500_eom", header: "SP by month US", source: "fred", sourceId: "SP500", kind: "daily_eom", firstMonth: null, group: "other", label: "S&P 500, EOM", units: "Index, close on the month's last trading day", decimals: 2, restricted: true },
  { col: "O", id: "us_10y2y_eom", header: "10yr vs 2yr US", source: "fred", sourceId: "T10Y2Y", kind: "daily_eom", firstMonth: "1976-06", group: "rates", label: "10y−2y, EOP", units: "Percentage points, month's last observation", decimals: 2 },
  { col: "P", id: "us_treasury_10y_avg", header: "10-Year Treasury Yield - Monthly Average US", source: "fred", sourceId: "GS10", kind: "monthly", firstMonth: "1953-04", group: "rates", label: "10-year, avg", units: "Percent, monthly average", decimals: 2 },
  { col: "Q", id: "us_treasury_2y_avg", header: "2-Year Treasury Yield - Monthly Average US", source: "fred", sourceId: "GS2", kind: "monthly", firstMonth: "1976-06", group: "rates", label: "2-year, avg", units: "Percent, monthly average", decimals: 2 },
  { col: "R", id: "us_pce_sa", header: "PCE - Seasonally Adjusted US", source: "fred", sourceId: "PCEPI", kind: "monthly", firstMonth: "1959-01", group: "us_inflation", label: "PCE", units: "Index, 2017=100", decimals: 3 },
  { col: "S", id: "us_core_pce_sa", header: "Core PCE - Seasonally Adjusted US", source: "fred", sourceId: "PCEPILFE", kind: "monthly", firstMonth: "1959-01", group: "us_inflation", label: "Core PCE", units: "Index, 2017=100 (excluding food and energy)", decimals: 3 },
].map(Object.freeze));

export const HEADERS = Object.freeze(COLUMNS.map(c => c.header));
export const SERIES = Object.freeze(COLUMNS.filter(c => c.source !== "date"));
export const STATCAN_SERIES = Object.freeze(SERIES.filter(c => c.source === "statcan"));
export const FRED_SERIES = Object.freeze(SERIES.filter(c => c.source === "fred"));
export const byId = Object.freeze(Object.fromEntries(SERIES.map(c => [c.id, c])));

// Preview groups (decision 3A). The Date column is shown with every group.
export const GROUPS = Object.freeze([
  { id: "canada", label: "Canada", ids: ["ca_cpi_headline_nsa", "ca_cpi_headline_sa", "ca_cpi_core_nsa", "ca_cpi_core_sa", "ca_cpi_alberta_nsa"] },
  { id: "us_inflation", label: "US Inflation", ids: ["us_cpi_headline_nsa", "us_cpi_headline_sa", "us_cpi_core_nsa", "us_cpi_core_sa", "us_pce_sa", "us_core_pce_sa"] },
  { id: "rates", label: "Rates", ids: ["us_fed_funds_avg", "us_fed_funds_eom", "us_10y2y_eom", "us_treasury_10y_avg", "us_treasury_2y_avg"] },
  { id: "other", label: "Other", ids: ["us_unemployment_sa", "us_sp500_eom"] },
].map(Object.freeze));

// FRED publishes only about the last ten years of SP500; requests start no earlier
// than this many years before the current month (a margin over FRED's window).
export const SP500_WINDOW_YEARS = 12;
