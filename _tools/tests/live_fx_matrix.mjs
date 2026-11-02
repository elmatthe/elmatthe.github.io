// OPT-IN live check: the FX matrix from both official sources through the site's own
// market-data code, cross-validated against each other. Two small requests.
//   node _tools/tests/live_fx_matrix.mjs        (behind a proxy: NODE_USE_ENV_PROXY=1)
import { fetchLatestCadRates, crossFromCad } from "../../assets/js/market-data/providers/boc.js";
import { fetchEcbLatestCadRates } from "../../assets/js/market-data/providers/ecb.js";

const CODES = ["USD", "EUR", "JPY", "GBP", "CNY"];
const PAIRS = [["USD", "CAD"], ["CAD", "USD"], ["EUR", "USD"], ["USD", "JPY"], ["GBP", "USD"], ["USD", "CNY"]];
const boc = await fetchLatestCadRates(CODES);
const ecb = await fetchEcbLatestCadRates(CODES);
let worst = 0;
console.log("pair      Bank of Canada (date)          ECB (date)                     diff");
for (const [a, b] of PAIRS) {
  const x = crossFromCad(a, b, boc);
  const y = crossFromCad(a, b, ecb);
  const diff = y.rate / x.rate - 1;
  worst = Math.max(worst, Math.abs(diff));
  console.log(`${a}/${b}   ${x.rate.toPrecision(6).padEnd(10)} (${x.date}, ${x.method})   ${y.rate.toPrecision(6).padEnd(10)} (${y.date}, ${y.method})   ${(diff * 100).toFixed(3)}%`);
}
// Different fixing times (BoC daily average vs ECB 14:15 CET) and possibly different
// dates; a gap above 2% would indicate a parsing or direction error.
if (worst > 0.02) { console.error(`FAIL: sources differ by ${(worst * 100).toFixed(2)}%`); process.exit(1); }
console.log(`PASS: official sources agree within ${(worst * 100).toFixed(3)}%`);
