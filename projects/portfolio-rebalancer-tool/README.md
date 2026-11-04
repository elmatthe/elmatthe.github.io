# Portfolio Rebalancer

A simple desktop tool that tells you exactly what to **buy, sell, or hold** to bring
a portfolio back to its target weights. It runs in its own window — no spreadsheets,
no terminal commands — and supports two everyday workflows:

- **New Money** — you have cash to invest. The tool produces buy-only recommendations
  and never spends more than your budget.
- **Rebalance (Pure)** — no new cash. Sells fund the buys, so the plan never spends
  more than your sale proceeds raise.

The same logic also runs in the browser on the project page, so you can try it before
downloading anything: <https://elmatthe.github.io/projects/portfolio-rebalancer/>

---

## What it does

- **Holdings:** ticker exactly as your broker shows it, shares (fractions allowed),
  target weight % and, optionally, the account type (TFSA, RRSP, Margin, …).
- **Automatic identity and prices:** when you finish typing a ticker (Enter or Tab),
  the program identifies the listing (exchange, currency, pence or pounds) without any
  request, then fetches its latest price from the first source in **your source list**
  that covers it: **Yahoo Finance** (no key needed; through the site's data gateway,
  briefly cached, may be delayed) and the providers you add with **your own key**
  (Alpha Vantage, Marketstack, Finnhub, Alpaca). **Sources…** shows the list: change the
  order with Move up / Move down, Alt+Up / Alt+Down or by dragging, and switch sources on
  or off. If a source cannot give a usable price, the next one is tried; each holding
  shows which source priced it and why earlier ones were skipped or failed. Prices are
  not called real-time unless the source says so.
- **Identity before price:** `YNVD.NE` (and `YNVD.TO`, as Questrade shows the same
  fund) is the NVIDIA (NVDA) Yield Shares Purpose ETF on **Cboe Canada**, in CAD. The
  program keeps your text, treats both spellings as the same instrument, never prices
  it as a Toronto Stock Exchange symbol (or from NVIDIA shares or another ETF). Yahoo
  Finance is asked for `YNVD.NE` on Cboe Canada and its answer is used only if it is that
  listing in CAD; the free plans of the key providers do not cover it. You can always
  supply a price yourself; it is labelled as user-supplied.
- **One list for every market:** Canadian, US and international holdings (Tokyo in
  JPY, Xetra in EUR, London quoted in pence and converted to pounds, Shanghai in CNY)
  use the same row, the same **Get prices** action, the same quota checks and the same
  plan. Get prices names every holding it could not price and why.
- **No plan without prices:** the plan appears only when every holding with shares or
  a target has a verified price in a confirmed currency, or a price you supplied.
  Holdings with 0 shares and a 0% target are left out.
- **Two modes, three invariants:** New Money (buy only, never over budget) and
  Rebalance (sells fund buys), with cross-account funding warnings. Optional whole
  shares (rounded down, then topped up with leftover cash).
- **Official exchange rates** from the Bank of Canada (ECB fallback), editable.
- **CSV and Excel export** with the provider, symbol, price type, trading date,
  retrieval time and currency evidence for every holding, the exchange rates and
  their sources, warnings and a disclaimer. Excel files are written as a new
  workbook.

The same engine runs in the browser on the project page:
<https://elmatthe.github.io/projects/portfolio-rebalancer/>. Automated tests check
that both give the same trades and the same messages.

### Keys and privacy

Keys are yours. Each one is sent only to its own provider (Finnhub and Alpaca in
request headers; Alpha Vantage and Marketstack in the request address, the only
method they offer). A key is kept until you close the program unless you tick
**Remember on this computer**, which saves it in `files/runtime/keys.json` in this
folder (readable only by your user where the system supports it). Keys never appear
in exports. Your holdings are never sent anywhere: only ticker symbols go to the
price provider and only currency codes to the central banks. The request counts
shown are what this computer sent; your provider counts every use of the key.

Massive (formerly Polygon.io) is evaluated but not offered: its market-data terms
restrict applications used by other people. See `_tools/PROVIDER_MATRIX.md` in the
website repository for every provider's limits and terms.

---

## What's under the hood

| Piece | Tool | Why |
|-------|------|-----|
| Language | **Python 3.11–3.14** | Runs the same on Windows and macOS; the launcher finds or installs it |
| Window / GUI | **tkinter** | Built into Python; DPI-aware on Windows |
| Market data | **`scripts/market_data/`** (standard library only) | Same provider rules, identity reference and notice handling as the web app |
| Spreadsheet export | **openpyxl** | Writes the `.xlsx` trade plan |

Everything except Python installs into a self-contained `.venv` folder inside this
folder — nothing is installed system-wide, and you can move or delete the folder
freely. The `yfinance` library is not used: Yahoo Finance is reached only through the
site's data gateway, one request at a time. No browser or local web server is needed.

---

## Download

1. Go to <https://elmatthe.github.io/projects/portfolio-rebalancer/>.
2. Click **Download portfolio-rebalancer.zip**.
3. Extract it anywhere you can write to (Desktop, Documents). Don't run it from inside
   the ZIP preview.

You'll get a `portfolio-rebalancer-tool` folder containing this README, the two setup launchers,
`config.toml` and the `scripts` folder.

---

## Setup & run

One launcher does everything: it checks the folder's private Python environment,
repairs or installs only what is missing, proves it works, then opens the program.
Healthy later launches skip straight to opening the program; no downloads happen.

### Windows
1. Double-click **`Setup_and_Run-portfolio-rebalancer.bat`**.
2. Because the file was downloaded from the internet, Windows SmartScreen or your
   security software may flag it the first time. If you are unsure whether it is safe to
   run, or if this is a work computer, check with your IT department before continuing.
3. If no suitable Python (3.11–3.14) is found, it asks (Y/N) before installing Python 3.13
   **for your user account only** with `winget`. No administrator rights are needed and
   your PATH is not changed. The Microsoft Store `python.exe` placeholder is never used.
4. The Portfolio Rebalancer window opens. To run it again later, double-click the same file.

### macOS
1. Double-click **`Setup_and_Run-portfolio-rebalancer.command`**.
2. The first time, macOS may say it "cannot be opened". Open **System Settings → Privacy &
   Security** and click **Open Anyway** (on a work computer, check with IT first).
3. If no suitable Python with tkinter is found, it offers a numbered menu: install with
   Homebrew (`python@3.13` + `python-tk@3.13`), or open the python.org download page.
4. The Portfolio Rebalancer window opens. To run it again later, double-click the same file.

> If the `.command` file won't run, open Terminal, type `chmod +x ` (with a trailing
> space), drag the file onto the window, and press Enter.

### Repair, move and reset
- **Moved the folder or something broke?** Just run the launcher again. It detects a
  stale or damaged `.venv`, rebuilds it (keeping a backup until the rebuild works) and
  reinstalls only the packages that are missing or at the wrong version.
- **Start completely fresh:** delete the `.venv` folder and run the launcher.
- **Logs:** the last setup log is `files/test-logs/setup-and-run-latest.log`; scratch
  files and the package cache stay in `files/temp/`.
- **Advanced options** (run from a terminal in this folder):
  `--venv-check` (report health, change nothing), `--repair-venv` (force a rebuild),
  `--setup-only` (set up without launching), `--launch-only` (launch only if already healthy).
  On Windows run e.g. `Setup_and_Run-portfolio-rebalancer.bat --venv-check`; on macOS
  `./Setup_and_Run-portfolio-rebalancer.command --venv-check`.

The full illustrated guide, including troubleshooting, is at <https://elmatthe.github.io/projects/portfolio-rebalancer-guide/>.

---

## How to use it

1. **Pick a mode** — New Money (you're adding cash) or Rebalance (no new cash).
2. **Enter each holding** — ticker exactly as your broker shows it, shares (fractions
   allowed), target weight % and, optionally, the account type. Weights are relative;
   the tool normalizes them. Press Enter or Tab: the ticker is identified and priced.
3. **Press Get prices** for every holding without a usable price. With no key, Yahoo
   Finance is used. Optionally add your own key under **API keys…** (Alpha Vantage,
   Marketstack, Finnhub or Alpaca): it joins **Sources…** below Yahoo Finance; move it up
   to try it first. The line above the holdings estimates the requests first, per
   source, and names the holdings outside Canada and the US and any no source covers.
4. **Set the reporting currency** (and a budget, in New Money mode), choose fractional
   or whole shares, and press **Calculate plan**. Export CSV or Excel when it is ready.

**Load sample** fills fourteen ordinary holdings with targets totalling exactly 100%
and no prices: VEQT.TO 305 (63%), CNQ.TO 48 (9%), XQQ.TO 27 (6.3%), HEWB.TO 14 (4.5%),
AAPL 2 (1.8%), VFV.TO 8 (0.9%), SPCX 1 (0.9%), CBRS 4 (0.9%), YNVD.NE 4 (1.8%),
VST 1 (0.9%), and one share each of 7203.T, SAP.DE, VOD.L and 600519.SS at 2.5%.
CAD reporting, New Money, budget 3,000. All fourteen are ordinary holdings, priced and
planned by the same rules.

---

## Folder layout

```
portfolio-rebalancer-tool/
  README.md                                <- this file
  Setup_and_Run-portfolio-rebalancer.bat      <- Windows setup + launcher
  Setup_and_Run-portfolio-rebalancer.command  <- macOS setup + launcher
  config.toml                              <- supported Python range + entry point
  scripts/
    bootstrap.py            <- assess / repair / prove / launch logic used by the launchers
    main.py                 <- entry point (opens the window)
    requirements.txt        <- pinned dependencies
    portfolio_rebalancer/   <- the program, split into focused modules
      core.py               <- buy/sell/hold math, three invariants, valuation gate, whole shares
      model.py              <- holdings, prices, readiness and the plan (no GUI)
      sample.py             <- the 14-holding sample portfolio (no prices)
      export.py             <- CSV / Excel export with sources
      ui.py                 <- the tkinter window
    market_data/            <- providers, identity reference, exchange rates (shared with the
                               Stock tool; identical to the web app's rules)
  files/                    <- created on first run: setup logs, runtime settings, saved keys
```

The source repository also contains `files/tests/` (pytest suite) and `md-instructions/`
(briefing and changelog); they are not part of the user download.

---

## Disclaimer

This tool is for illustrative and educational planning use only. It is not financial,
investment, or trading advice. Always verify prices at your broker before placing any
orders.
