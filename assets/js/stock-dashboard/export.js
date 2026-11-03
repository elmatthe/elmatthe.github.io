// Workbook content for the Stock Comparison & Analytics browser export.
//
// Five value-only sheets built from the latest completed comparison; nothing is
// re-fetched. File writing lives in ../shared/export-files.js.

export const SHEETS = ["Read Me & Sources", "Executive Summary", "Model & Calculations", "Portfolio Risk", "Raw Data Ingestion"];

const header = cells => ({ header: true, cells });

// Shown with every live result: the free tier decides frequency and basis by window.
export const LIVE_DATA_NOTE = "Live data (Alpha Vantage free tier): windows up to about 4 months use daily closes as traded (not adjusted for splits or dividends); longer windows use weekly closes adjusted for splits and dividends. Results for different horizons can therefore differ in sampling frequency and price basis, not only in period.";

// The free (keyless) source: one label everywhere, and what its data is.
export const FREE_SOURCE_LABEL = "Yahoo Finance (free source, no key)";
export const FREE_DATA_NOTE = "Free source (Yahoo Finance chart data through this site's market-data gateway, no key): daily prices for every horizon. 'Close' is adjusted for splits but not for dividends (price return); 'Adjusted close' also reflects dividends and capital-gain distributions, as Yahoo Finance calculates them. Prices may be delayed, the session still trading is left out, and days the source reports without a price are skipped, never filled in. Not an exchange's official data.";

// The source a series actually came from ("source (via)"), for per-row export columns.
export function sourceOf(comparison, ticker) {
  const p = (comparison.provenance || []).find(x => x.ticker === ticker);
  if (!p) return comparison.source || "";
  return p.via ? `${p.source} (${p.via})` : p.source;
}

// The price basis actually used, compared with the one requested.
export function basisSummary(comparison) {
  const series = comparison.series || [];
  if (series.some(s => s.priceBasis === "synthetic")) return "synthetic prices (not market data)";
  if (comparison.basis === "close") return "plain closes (price return)";
  const plain = series.filter(s => s.priceBasis !== "adjusted_close").map(s => s.ticker);
  if (!plain.length) return "adjusted closes (total return)";
  if (plain.length === series.length) return "plain closes (price return); adjusted closes were requested but are not available for this data";
  return `adjusted closes requested; plain closes (price return) used for ${plain.join(", ")}`;
}

// Which currency the results are in, and anything left out to keep that true.
export function currencySummary(comparison) {
  if (comparison.normalizedTo) {
    const left = comparison.excludedForCurrency || [];
    return `normalized to ${comparison.normalizedTo}${left.length ? ` (left out, not convertible: ${left.join(", ")})` : ""}`;
  }
  const labels = [...new Set((comparison.series || []).map(s => s.currency || "unknown"))].sort();
  return labels.length > 1 ? `native currencies, mixed (${labels.join(", ")})` : `native currency (${labels[0] || "unknown"})`;
}

// Per ticker: native currency, the currency its values are shown in, and how.
export function currencyRows(comparison) {
  return (comparison.series || []).map(s => {
    const native = s.nativeCurrency || s.currency || null;
    let how;
    if (comparison.normalizedTo) {
      how = native === comparison.normalizedTo ? `Already in ${native}` : `Converted from ${native} with ${comparison.fxSources?.[native] || "official daily rates"}`;
    } else {
      how = s.currency ? "Not converted (native currencies chosen)" : "Currency unknown; not converted";
    }
    return [s.ticker, native || "unknown", s.currency || "unknown", how];
  });
}

const PERIOD_NAME = { daily: "day", weekly: "week", monthly: "month" };

export function buildWorkbookSheets({ comparison, generatedAt = new Date().toISOString() }) {
  const frequency = comparison.frequency || "daily";
  const P = comparison.periodsPerYear || 252;
  const readMe = [
    header(["Stock Comparison & Analytics Tool — browser export"]),
    ["Generated at (UTC)", generatedAt],
    ["Disclaimer", "Informational analysis only; not investment, financial, legal, or tax advice."],
    ["Data source", comparison.source === "Synthetic demo" ? "Synthetic demo prices generated in the browser (not real market data)." : comparison.source === "Your CSV file" ? "Price files supplied by the user (read in the browser)." : comparison.source === FREE_SOURCE_LABEL ? "Yahoo Finance chart data through this site's market-data gateway, with no key (unofficial endpoint; may be delayed; not an exchange's official data)." : "Alpha Vantage, fetched with the user's own API key (personal use)."],
    ["Units", "Returns, volatility and drawdown are decimal fractions (0.05 = 5%). Prices are in the currency shown for each ticker below."],
    ["Method", `${frequency} log returns on ${basisSummary(comparison)}, aligned on identical intervals (${frequency === "daily" ? "same dates" : frequency === "weekly" ? "same ISO weeks" : "same months"}); ${P} periods per year.`],
    ["Sampling frequency", `${frequency} (${P} periods per year)`],
    ["Price basis", basisSummary(comparison)],
    ["Currency", currencySummary(comparison)],
    ...(comparison.liveNote ? [[comparison.source === FREE_SOURCE_LABEL ? "Free source note" : "Live data note", comparison.liveNote]] : []),
    [],
    header(["Ticker", "Source", "Delivered via", "Price basis", "Retrieved at (UTC)", "Cached"]),
  ];
  comparison.provenance.forEach(p => readMe.push([p.ticker, p.source, p.via || "", p.basis || "", p.retrievedAt || "", p.stale ? "saved copy (refresh failed)" : p.cached ? "yes" : "no"]));
  readMe.push([], header(["Ticker", "Native currency", "Values shown in", "Conversion"]), ...currencyRows(comparison));
  if (comparison.warnings.length) {
    readMe.push([], header(["Warnings"]));
    comparison.warnings.forEach(w => readMe.push([w]));
  }

  const summary = [
    header([`Comparison · ${comparison.horizon} · ${comparison.requestedStart} to ${comparison.requestedEnd} · ${frequency} · ${currencySummary(comparison)}`]),
    header(["Ticker", "Currency", "Native currency", "Price basis", "Total return", "Annualized return", "Annualized volatility", "Sharpe ratio", "Max drawdown", "Return observations", "Actual start", "Actual end"]),
    ...comparison.metrics.map(m => [m.ticker, m.currency || "unknown", m.nativeCurrency || m.currency || "unknown", m.priceBasis || "", m.totalReturn, m.annualizedReturn, m.annualizedVolatility, m.sharpe, m.maxDrawdown, m.returnObservations, m.actualStart || "", m.actualEnd || ""]),
  ];

  const model = [
    header(["Measure", "Definition"]),
    ["Log return", "ln(price_t / price_t-1) between consecutive observations of the chosen price basis"],
    ["Total return", "last price / first price − 1"],
    ["Annualized return", `exp(mean log return × ${P}) − 1`],
    ["Annualized volatility", `sample standard deviation of log returns × √${P}`],
    ["Sharpe ratio", `(mean log return × ${P} − ln(1 + risk-free rate)) ÷ annualized volatility`],
    ["Max drawdown", "minimum of price ÷ running peak − 1"],
    ["Correlation", "Pearson correlation over identical return intervals; unavailable below 3 shared returns or at zero variance"],
    ["Regression", "OLS of excess log returns on the benchmark's excess log returns; two-tailed Student-t p-value for beta"],
  ];
  if (comparison.regression?.rows.length) {
    model.push([], header([`Regression vs ${comparison.regression.benchmark}`, `Alpha (per ${PERIOD_NAME[frequency] || "period"})`, "Alpha (annualized)", "Beta", "R²", "t-stat", "p-value", "Observations"]));
    comparison.regression.rows.forEach(r => model.push([r.ticker, r.alpha, r.alphaAnnualized, r.beta, r.r2, r.t, r.p, r.n]));
  }
  model.push([], ["Risk-free rate (annual, decimal)", comparison.riskFree]);

  const risk = [header(["Correlation", ...comparison.tickers])];
  comparison.tickers.forEach(left => risk.push([left, ...comparison.tickers.map(right => comparison.matrix[left][right])]));
  risk.push([], header(["Shared return observations", ...comparison.tickers]));
  comparison.tickers.forEach(left => risk.push([left, ...comparison.tickers.map(right => comparison.counts[left][right])]));

  const raw = [header(["Date", "Ticker", "Price", "Price basis", "Currency", "Native currency", "Source"])];
  comparison.series.forEach(s => { const src = sourceOf(comparison, s.ticker); s.observations.forEach(o => raw.push([o.date.toISOString().slice(0, 10), s.ticker, o.price, s.priceBasis || "", s.currency || "unknown", s.nativeCurrency || s.currency || "unknown", src])); });

  return [readMe, summary, model, risk, raw].map((rows, i) => ({ name: SHEETS[i], rows }));
}
