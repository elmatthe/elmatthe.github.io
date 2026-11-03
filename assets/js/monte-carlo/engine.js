// Monte Carlo retirement engine (no DOM, no network).
//
// Same model, parsing rules, validation limits, messages and random-number generator
// as the desktop program's scripts/monte_carlo/core.py and rng.py:
//   accumulation: value = value x (1 + r) + contribution (year-end); contribution grows
//                 yearly; a negative value is floored at 0 but can recover;
//   retirement:   value = value x (1 + r) - withdrawal (year-end); the first-year
//                 withdrawal is spending - pension income in retirement-year dollars and
//                 grows with inflation each year; reaching 0 or less is a failure (ruin)
//                 and the path stays at 0;
//   r ~ Normal(expected return, volatility): the expected return is the ARITHMETIC mean
//       of simple annual returns, drawn independently once per simulated year.
// Spending basis: "retirement" (default, the original behaviour) means spending and
// pension are entered in first-retirement-year dollars; "today" means today's dollars,
// converted with W1 = (spending - pension) x (1 + inflation)^yearsToRetirement.
// Percentiles use linear interpolation (numpy's default). "Real" values divide
// nominal values by (1 + inflation)^year.
// `normal` can be injected (a function returning standard-normal draws) so tests
// can feed both engines identical random sequences; the apps pass the seeded
// generator below so any run can be reproduced from its seed.

export const ENGINE_VERSION = "2.0.0";
export const RNG_NAME = "mulberry32 + Box-Muller (cosine branch)";

export const LIMITS = {
  maxMoney: 1e15,
  maxYears: 120,
  maxAbsRate: 100,
  maxVolatility: 300,
  maxSimulations: 10000,
};

export const SPENDING_BASES = {
  retirement: "Retirement-year dollars",
  today: "Today's dollars",
};
export const DEFAULT_SPENDING_BASIS = "retirement";

// Warning thresholds (shared with the desktop program).
export const HIGH_VOLATILITY = 30;
export const TOTAL_LOSS_WARN = 1e-4;

const LABELS = {
  currentPortfolio: "Current portfolio value",
  annualContribution: "Annual contribution",
  annualSpending: "Annual retirement spending",
  pensionIncome: "CPP / OAS / Pension income",
};

export class ValidationError extends Error {
  constructor(message, field) { super(message); this.name = "ValidationError"; this.field = field; }
}

// One number grammar for both apps: optional sign, ASCII digits with an optional
// decimal point, optional exponent. No thousands separators, hex, "nan", "inf",
// underscores or non-ASCII digits.
export const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
export function parseNumberText(text) {
  const trimmed = String(text ?? "").trim();
  if (!NUMBER_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// `raw` values are strings or numbers keyed as in LABELS plus contributionGrowth,
// expectedReturn, volatility, inflation (percent), yearsToRetirement,
// yearsInRetirement, simulations and the optional spendingBasis.
// Returns numeric inputs with rates as percent.
export function validateInputs(raw) {
  const fail = (message, field) => { throw new ValidationError(message, field); };
  const number = (field, message) => {
    const value = parseNumberText(raw[field]);
    if (value === null) fail(message, field);
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
    spendingBasis: String(raw.spendingBasis ?? "").trim() || DEFAULT_SPENDING_BASIS,
  };
  if (!Object.hasOwn(SPENDING_BASES, inputs.spendingBasis)) fail('Spending basis must be "retirement" or "today".', "spendingBasis");
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

// (1 + inflation)^yearsToRetirement by repeated multiplication, exactly as the
// withdrawal is indexed each year (and bit-identical in both engines).
export function inflationFactor(inflationPercent, years) {
  const step = 1 + inflationPercent / 100;
  let factor = 1;
  for (let k = 0; k < years; k += 1) factor *= step;
  return factor;
}

// First-year net withdrawal in retirement-year (nominal) dollars, as the model uses it.
export function firstYearWithdrawal(inputs) {
  const entered = inputs.annualSpending - inputs.pensionIncome;
  const basis = inputs.spendingBasis || DEFAULT_SPENDING_BASIS;
  const factor = basis === "today" ? inflationFactor(inputs.inflation, inputs.yearsToRetirement) : 1;
  return { entered, factor, nominal: entered * factor, basis };
}

// Standard normal CDF via the Numerical Recipes erfc approximation (fractional error
// below 1.2e-7): good enough for a warning and identical in both engines.
export function normalCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - 0.5 * erfc : 0.5 * erfc;
}

// Probability that one simulated year returns less than -100% (more than a total loss).
export function totalLossProbability(inputs) {
  if (inputs.volatility <= 0) return inputs.expectedReturn < -100 ? 1 : 0;
  return normalCdf((-100 - inputs.expectedReturn) / inputs.volatility);
}

// Approximate typical (median) compound growth per year for normal simple returns:
// exp(ln(1 + mu) - sigma^2 / (2 (1 + mu)^2)) - 1, in percent. Null when undefined.
export function typicalGrowth(expectedReturnPercent, volatilityPercent) {
  const mu = expectedReturnPercent / 100;
  const sigma = volatilityPercent / 100;
  if (mu <= -1) return null;
  return (Math.exp(Math.log(1 + mu) - (sigma * sigma) / (2 * (1 + mu) * (1 + mu))) - 1) * 100;
}

const percentText = value => (value >= 1 ? value.toFixed(1) : value.toFixed(2));

// Non-blocking warnings about the assumptions; identical text in the desktop program.
export function assumptionWarnings(inputs) {
  const out = [];
  const mu = inputs.expectedReturn;
  const sigma = inputs.volatility;
  if (mu !== 0 && Math.abs(mu) < 1) {
    out.push({ code: "return_looks_fractional", message: "Expected return is entered in percent: a value between -1 and 1 (for example 0.07) means less than 1% a year. For 7% a year, enter 7." });
  }
  if (sigma > 0 && sigma < 1) {
    out.push({ code: "volatility_looks_fractional", message: "Volatility is entered in percent: a value below 1 (for example 0.12) means less than 1% a year. For 12%, enter 12." });
  }
  if (sigma > HIGH_VOLATILITY) {
    out.push({ code: "volatility_high", message: `Volatility above ${HIGH_VOLATILITY}% a year is far higher than diversified portfolios have shown historically; treat these results with caution.` });
  }
  const loss = totalLossProbability(inputs);
  if (loss >= TOTAL_LOSS_WARN) {
    out.push({ code: "returns_below_total_loss", message: `With this expected return and volatility, about ${percentText(loss * 100)}% of simulated years return less than -100% (a loss larger than the whole portfolio), which a real portfolio cannot do. The model treats such a year as a total loss (the balance becomes $0), so the results overstate the risk of running out. Consider a lower volatility.` });
  }
  if (inputs.inflation <= -100) {
    out.push({ code: "real_values_undefined", message: "With inflation at -100%, real (today's) dollars are undefined; results are available in nominal dollars only." });
  }
  return out;
}

// Seeded uniform generator (mulberry32): the same seed reproduces the same paths.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MAX_SEED = 4294967295;

// Seed text -> integer seed, or null for "random". Throws on invalid text.
export function parseSeed(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  if (!/^\d{1,10}$/.test(trimmed) || Number(trimmed) > MAX_SEED) throw new ValidationError(`Seed must be a whole number from 0 to ${MAX_SEED.toLocaleString("en-US")}, or blank for a random run.`, "seed");
  return Number(trimmed);
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

export const MODEL_NOTE = "Annual return ~ Normal(arithmetic expected return, volatility), independent each year; "
  + "year-end contributions and withdrawals; a negative balance before retirement is floored at 0; "
  + "ruin when the balance reaches 0 or less in retirement; withdrawal grows with inflation; "
  + "real = nominal / (1 + inflation)^year; percentiles by linear interpolation.";

export function runSimulation(inputs, { normal = boxMuller() } = {}) {
  const years = inputs.yearsToRetirement + inputs.yearsInRetirement;
  const mean = inputs.expectedReturn / 100;
  const vol = inputs.volatility / 100;
  const growth = inputs.contributionGrowth / 100;
  const inflation = inputs.inflation / 100;
  const first = firstYearWithdrawal(inputs);
  const netWithdrawal = finiteOrThrow(first.nominal, "Inflation-adjusted withdrawal produced non-finite values. Use smaller spending/pension inputs or inflation rates.");
  const byYear = Array.from({ length: years + 1 }, () => new Float64Array(inputs.simulations));
  const finals = new Float64Array(inputs.simulations);
  const atRetirement = new Float64Array(inputs.simulations);
  const ruinYears = [];
  let draws = 0;

  for (let sim = 0; sim < inputs.simulations; sim += 1) {
    let value = inputs.currentPortfolio;
    let contribution = inputs.annualContribution;
    byYear[0][sim] = value;
    for (let y = 1; y <= inputs.yearsToRetirement; y += 1) {
      draws += 1;
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
      draws += 1;
      value = finiteOrThrow(value * (1 + (mean + vol * normal())) - withdrawal, "Simulation produced non-finite values during retirement. Reduce large input magnitudes and try again.");
      if (value <= 0) { value = 0; ruined = true; ruinYears.push(r); }
      byYear[idx][sim] = value;
      withdrawal = finiteOrThrow(withdrawal * (1 + inflation), "Inflation-adjusted withdrawal produced non-finite values. Use smaller spending/pension inputs or inflation rates.");
    }
    finals[sim] = value;
    atRetirement[sim] = byYear[inputs.yearsToRetirement][sim];
  }

  // Real (today's) dollars: nominal / (1 + inflation)^year. With inflation at -100%
  // the deflator is zero and real values are undefined, so they are reported as null.
  const deflator = year => (1 + inflation) ** year;
  const realAvailable = 1 + inflation > 0;
  const deflate = (v, year) => {
    if (!realAvailable) return null;
    const real = v / deflator(year);
    return Number.isFinite(real) ? real : null;
  };
  const percentilesByYear = byYear.map((values, year) => {
    const nominal = bands(values);
    return { year, nominal, real: Object.fromEntries(Object.entries(nominal).map(([k, v]) => [k, deflate(v, year)])) };
  });
  const finalNominal = bands(finals);
  const retirementNominal = bands(atRetirement);
  const toReal = (stats, year) => Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, deflate(v, year)]));
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
    netWithdrawalEntered: first.entered,
    spendingBasis: first.basis,
    inflationFactorToRetirement: first.factor,
    realAvailable,
    draws,
  };
  for (const value of [summary.successProbability, retirementNominal.p50, finalNominal.p50, finalNominal.p10, finalNominal.p90, swr]) {
    finiteOrThrow(value, "Simulation output became non-finite. Reduce large input magnitudes and try again.");
  }
  return {
    summary, percentilesByYear, retirementYear: inputs.yearsToRetirement, totalYears: years, inputs,
    warnings: assumptionWarnings(inputs), engineVersion: ENGINE_VERSION, model: MODEL_NOTE,
  };
}
