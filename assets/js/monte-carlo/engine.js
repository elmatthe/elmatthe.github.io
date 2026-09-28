// Monte Carlo retirement engine (no DOM, no network).
//
// Same model, validation limits and messages as the desktop program's
// scripts/monte_carlo/core.py:
//   accumulation: value = value x (1 + r) + contribution; contribution grows yearly;
//                 negative values clamp to 0 but can recover;
//   retirement:   value = value x (1 + r) - withdrawal; withdrawal starts at
//                 spending - pension income and grows with inflation each year;
//                 reaching 0 is a failure (ruin) and the path stays at 0;
//   r ~ Normal(expected return, volatility), drawn once per simulated year.
// Percentiles use linear interpolation (numpy's default). "Real" values divide
// nominal values by (1 + inflation)^year.
// `normal` can be injected (a function returning standard-normal draws) so tests
// can feed both engines identical random sequences.

export const LIMITS = {
  maxMoney: 1e15,
  maxYears: 120,
  maxAbsRate: 100,
  maxVolatility: 300,
  maxSimulations: 10000,
};

const LABELS = {
  currentPortfolio: "Current portfolio value",
  annualContribution: "Annual contribution",
  annualSpending: "Annual retirement spending",
  pensionIncome: "CPP / OAS / Pension income",
};

export class ValidationError extends Error {
  constructor(message, field) { super(message); this.name = "ValidationError"; this.field = field; }
}

// `raw` values are strings or numbers keyed as in LABELS plus contributionGrowth,
// expectedReturn, volatility, inflation (percent), yearsToRetirement,
// yearsInRetirement and simulations. Returns numeric inputs with rates as percent.
export function validateInputs(raw) {
  const fail = (message, field) => { throw new ValidationError(message, field); };
  const number = (field, message) => {
    const text = String(raw[field] ?? "").trim();
    const value = Number(text);
    if (text === "" || !Number.isFinite(value)) fail(message, field);
    return value;
  };
  const integer = (field, message) => {
    const value = number(field, message);
    if (!Number.isInteger(value)) fail(message, field);
    return value;
  };
  const inputs = {
    currentPortfolio: number("currentPortfolio", "Current portfolio value must be a finite numeric value."),
    annualContribution: number("annualContribution", "Annual contribution must be a finite numeric value."),
    contributionGrowth: number("contributionGrowth", "Contribution growth rate must be a finite numeric value."),
    yearsToRetirement: integer("yearsToRetirement", `Years to retirement must be between 1 and ${LIMITS.maxYears}.`),
    yearsInRetirement: integer("yearsInRetirement", `Years in retirement must be between 1 and ${LIMITS.maxYears}.`),
    expectedReturn: number("expectedReturn", "Expected annual return must be a finite numeric value."),
    volatility: number("volatility", "Volatility must be a finite numeric value."),
    inflation: number("inflation", "Inflation rate must be a finite numeric value."),
    annualSpending: number("annualSpending", "Annual retirement spending must be a finite numeric value."),
    pensionIncome: number("pensionIncome", "CPP / OAS / Pension income must be a finite numeric value."),
    simulations: integer("simulations", `Number of simulations must be a whole number between 1 and ${LIMITS.maxSimulations.toLocaleString("en-US")}.`),
  };
  for (const [field, label] of Object.entries(LABELS)) {
    const value = inputs[field];
    const mustBePositive = field === "currentPortfolio" || field === "annualSpending";
    if (mustBePositive && value <= 0) fail(`${label} must be greater than 0.`, field);
    if (!mustBePositive && value < 0) fail(`${label} must be 0 or greater.`, field);
    if (Math.abs(value) > LIMITS.maxMoney) fail(`${label} is too large. Use values less than or equal to ${LIMITS.maxMoney.toLocaleString("en-US")}.`, field);
  }
  const rate = (field, label) => {
    if (Math.abs(inputs[field]) > LIMITS.maxAbsRate) fail(`${label} must be between -${LIMITS.maxAbsRate}% and ${LIMITS.maxAbsRate}%.`, field);
  };
  rate("contributionGrowth", "Contribution growth rate");
  rate("expectedReturn", "Expected annual return");
  if (inputs.volatility < 0 || inputs.volatility > LIMITS.maxVolatility) fail(`Volatility must be between 0% and ${LIMITS.maxVolatility}%.`, "volatility");
  rate("inflation", "Inflation rate");
  if (inputs.yearsToRetirement < 1 || inputs.yearsToRetirement > LIMITS.maxYears) fail(`Years to retirement must be between 1 and ${LIMITS.maxYears}.`, "yearsToRetirement");
  if (inputs.yearsInRetirement < 1 || inputs.yearsInRetirement > LIMITS.maxYears) fail(`Years in retirement must be between 1 and ${LIMITS.maxYears}.`, "yearsInRetirement");
  if (inputs.simulations < 1 || inputs.simulations > LIMITS.maxSimulations) fail(`Number of simulations must be a whole number between 1 and ${LIMITS.maxSimulations.toLocaleString("en-US")}.`, "simulations");
  if (inputs.pensionIncome >= inputs.annualSpending) {
    fail("CPP/OAS/Pension income must be less than annual retirement spending. If pension income fully covers spending, simulation is not required.", "pensionIncome");
  }
  return inputs;
}

export function boxMuller(random = Math.random) {
  return () => {
    const u1 = Math.max(random(), 1e-12);
    const u2 = random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

// numpy.percentile(..., method="linear") on a pre-sorted array.
export function percentileSorted(sorted, q) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
}

function bands(values) {
  const sorted = Float64Array.from(values).sort();
  return {
    p10: percentileSorted(sorted, 0.10), p25: percentileSorted(sorted, 0.25), p50: percentileSorted(sorted, 0.50),
    p75: percentileSorted(sorted, 0.75), p90: percentileSorted(sorted, 0.90),
  };
}

const finiteOrThrow = (value, message) => { if (!Number.isFinite(value)) throw new Error(message); return value; };

export function runSimulation(inputs, { normal = boxMuller() } = {}) {
  const years = inputs.yearsToRetirement + inputs.yearsInRetirement;
  const mean = inputs.expectedReturn / 100;
  const vol = inputs.volatility / 100;
  const growth = inputs.contributionGrowth / 100;
  const inflation = inputs.inflation / 100;
  const netWithdrawal = inputs.annualSpending - inputs.pensionIncome;
  const byYear = Array.from({ length: years + 1 }, () => new Float64Array(inputs.simulations));
  const finals = new Float64Array(inputs.simulations);
  const atRetirement = new Float64Array(inputs.simulations);
  const ruinYears = [];

  for (let sim = 0; sim < inputs.simulations; sim += 1) {
    let value = inputs.currentPortfolio;
    let contribution = inputs.annualContribution;
    byYear[0][sim] = value;
    for (let y = 1; y <= inputs.yearsToRetirement; y += 1) {
      value = finiteOrThrow(value * (1 + (mean + vol * normal())) + contribution, "Simulation produced non-finite values. Reduce large input magnitudes and try again.");
      if (value < 0) value = 0;
      byYear[y][sim] = value;
      contribution = finiteOrThrow(contribution * (1 + growth), "Contribution growth produced non-finite values. Use smaller contribution inputs or growth rates.");
    }
    let withdrawal = netWithdrawal;
    let ruined = false;
    for (let r = 1; r <= inputs.yearsInRetirement; r += 1) {
      const idx = inputs.yearsToRetirement + r;
      if (ruined) { byYear[idx][sim] = 0; continue; }
      value = finiteOrThrow(value * (1 + (mean + vol * normal())) - withdrawal, "Simulation produced non-finite values during retirement. Reduce large input magnitudes and try again.");
      if (value <= 0) { value = 0; ruined = true; ruinYears.push(r); }
      byYear[idx][sim] = value;
      withdrawal = finiteOrThrow(withdrawal * (1 + inflation), "Inflation-adjusted withdrawal produced non-finite values. Use smaller spending/pension inputs or inflation rates.");
    }
    finals[sim] = value;
    atRetirement[sim] = byYear[inputs.yearsToRetirement][sim];
  }

  const deflator = year => (1 + inflation) ** year;
  const percentilesByYear = byYear.map((values, year) => {
    const nominal = bands(values);
    const d = deflator(year);
    return { year, nominal, real: Object.fromEntries(Object.entries(nominal).map(([k, v]) => [k, v / d])) };
  });
  const finalNominal = bands(finals);
  const retirementNominal = bands(atRetirement);
  const toReal = (stats, year) => Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v / deflator(year)]));
  const finalReal = toReal(finalNominal, years);
  const retirementReal = toReal(retirementNominal, inputs.yearsToRetirement);
  const failed = ruinYears.length;
  const swr = retirementNominal.p50 > 0 ? netWithdrawal / retirementNominal.p50 * 100 : 0;
  const medianRuinYear = failed ? percentileSorted(Float64Array.from(ruinYears).sort(), 0.5) : null;
  const summary = {
    successProbability: (inputs.simulations - failed) / inputs.simulations * 100,
    failedRuns: failed,
    totalRuns: inputs.simulations,
    medianRetirement: { nominal: retirementNominal.p50, real: retirementReal.p50 },
    medianFinal: { nominal: finalNominal.p50, real: finalReal.p50 },
    finalP10: { nominal: finalNominal.p10, real: finalReal.p10 },
    finalP25: { nominal: finalNominal.p25, real: finalReal.p25 },
    finalP75: { nominal: finalNominal.p75, real: finalReal.p75 },
    finalP90: { nominal: finalNominal.p90, real: finalReal.p90 },
    swr,
    medianRuinYear,
    netWithdrawal,
  };
  for (const value of [summary.successProbability, retirementNominal.p50, finalNominal.p50, finalNominal.p10, finalNominal.p90, swr]) {
    finiteOrThrow(value, "Simulation output became non-finite. Reduce large input magnitudes and try again.");
  }
  return { summary, percentilesByYear, retirementYear: inputs.yearsToRetirement, totalYears: years, inputs };
}
