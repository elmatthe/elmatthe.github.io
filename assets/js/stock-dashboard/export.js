// Workbook content for the Stock Comparison & Analytics browser export.
//
// Five value-only sheets built from the latest completed comparison; nothing is
// re-fetched. File writing lives in ../shared/export-files.js.

export const SHEETS = ["Read Me & Sources", "Executive Summary", "Model & Calculations", "Portfolio Risk", "Raw Data Ingestion"];

const header = cells => ({ header: true, cells });

export function buildWorkbookSheets({ comparison, generatedAt = new Date().toISOString() }) {
  const frequency = comparison.frequency || "daily";
  const P = comparison.periodsPerYear || 252;
  const basisText = comparison.basis === "close" ? "closing prices (price return)" : "adjusted closes where available (total return)";
  const readMe = [
    header(["Stock Comparison & Analytics Tool — browser export"]),
    ["Generated at (UTC)", generatedAt],
    ["Disclaimer", "Informational analysis only; not investment, financial, legal, or tax advice."],
    ["Data source", comparison.source === "Synthetic demo" ? "Synthetic demo prices generated in the browser (not real market data)." : comparison.source === "Your CSV file" ? "Price files supplied by the user (read in the browser)." : "Alpha Vantage, fetched with the user's own API key (personal use)."],
    ["Units", "Returns, volatility and drawdown are decimal fractions (0.05 = 5%). Prices are in the listed currency unless normalized."],
    ["Method", `${frequency} log returns on ${basisText}, aligned on identical intervals (${frequency === "daily" ? "same dates" : frequency === "weekly" ? "same ISO weeks" : "same months"}); ${P} periods per year.`],
    [],
    header(["Ticker", "Source", "Delivered via", "Price basis", "Retrieved at (UTC)", "Cached"]),
  ];
  comparison.provenance.forEach(p => readMe.push([p.ticker, p.source, p.via || "", p.basis || "", p.retrievedAt || "", p.stale ? "saved copy (refresh failed)" : p.cached ? "yes" : "no"]));
  if (comparison.normalizedTo) {
    readMe.push([], header(["Currency", `Converted to ${comparison.normalizedTo} using`]));
    Object.entries(comparison.fxSources || {}).forEach(([cur, src]) => readMe.push([cur, src]));
  }
  if (comparison.warnings.length) {
    readMe.push([], header(["Warnings"]));
    comparison.warnings.forEach(w => readMe.push([w]));
  }

  const summary = [
    header([`Comparison · ${comparison.horizon} · ${comparison.requestedStart} to ${comparison.requestedEnd}${comparison.normalizedTo ? ` · normalized to ${comparison.normalizedTo}` : ""}`]),
    header(["Ticker", "Currency", "Price basis", "Total return", "Annualized return", "Annualized volatility", "Sharpe ratio", "Max drawdown", "Return observations", "Actual start", "Actual end"]),
    ...comparison.metrics.map(m => [m.ticker, m.currency || "", m.priceBasis || "", m.totalReturn, m.annualizedReturn, m.annualizedVolatility, m.sharpe, m.maxDrawdown, m.returnObservations, m.actualStart || "", m.actualEnd || ""]),
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
    model.push([], header([`Regression vs ${comparison.regression.benchmark}`, "Alpha (daily)", "Alpha (annualized)", "Beta", "R²", "t-stat", "p-value", "Observations"]));
    comparison.regression.rows.forEach(r => model.push([r.ticker, r.alpha, r.alphaAnnualized, r.beta, r.r2, r.t, r.p, r.n]));
  }
  model.push([], ["Risk-free rate (annual, decimal)", comparison.riskFree]);

  const risk = [header(["Correlation", ...comparison.tickers])];
  comparison.tickers.forEach(left => risk.push([left, ...comparison.tickers.map(right => comparison.matrix[left][right])]));
  risk.push([], header(["Shared return observations", ...comparison.tickers]));
  comparison.tickers.forEach(left => risk.push([left, ...comparison.tickers.map(right => comparison.counts[left][right])]));

  const raw = [header(["Date", "Ticker", "Price", "Price basis", "Currency"])];
  comparison.series.forEach(s => s.observations.forEach(o => raw.push([o.date.toISOString().slice(0, 10), s.ticker, o.price, s.priceBasis || "", s.currency || ""])));

  return [readMe, summary, model, risk, raw].map((rows, i) => ({ name: SHEETS[i], rows }));
}
