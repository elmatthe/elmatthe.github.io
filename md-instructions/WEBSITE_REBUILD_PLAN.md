# Website Rebuild & Expansion Plan

**Repo:** `elmatthe/elmatthe.github.io` (Jekyll + GitHub Pages)
**Author of plan:** prepared for Claude Code to implement
**Live site:** https://elmatthe.github.io/

---

## 0. How to use this document

You (Claude Code) are working in the local clone of `elmatthe.github.io`. Implement the
phases below **in order**. Each phase is self-contained and ends with an **Acceptance
check** — do not move to the next phase until the current one passes.

Rules of engagement:

1. **Audit before editing.** At the start of each phase, read the files it touches and
   confirm the current state matches what this plan assumes. The repo has been edited
   recently and some READMEs / docs may be stale — trust the actual files over any
   documentation.
2. **Small commits.** One commit per phase (or per step inside a phase). Use clear
   messages, e.g. `chore: remove finance knowledge hub (notes/)`.
3. **Don't touch unrelated files.** Preserve the existing visual style in
   `assets/main.scss` and match the existing page front-matter conventions when creating
   new pages.
4. **Match existing conventions.** Before creating any new page, open an existing page of
   the same kind (e.g. `projects.md`, `projects/portfolio-rebalancer.md`) and copy its
   front-matter shape, layout reference, and section structure.
5. **Build locally and verify** at the end of each phase: `bundle exec jekyll serve` and
   click through the affected pages.

---

## 1. Current state snapshot (verify first)

Top-level pages: `index.md`, `projects.md` (→ `/Projects/`), `scripts.md` (→ `/scripts/`),
`about.md` / `about.html`, plus `notes/` and `projects/` directories.

Known issues to keep in mind:

- **`/about/` redirect loop** — there are both `about.md` and `about.html` in the root.
  This likely causes a self-redirect. Resolve as part of Phase 4 (see step 4.4).
- **Navigation label inconsistency** — the Monte Carlo page nav shows
  "Finance Knowledge Hub" while the Portfolio Rebalancer page nav shows "Notes" for the
  same link. The whole nav is being reworked in Phase 4, which will fix this.
- **VBA `.bas` files have already been deleted** from the repo by the owner, but
  `scripts.md` and possibly the README still reference them (Phase 2 cleans this up).

---

## 2. Goals (what this plan delivers)

1. **Remove the Finance Knowledge Hub** (`/notes/`) entirely — it was never maintained.
2. **Add a new "Software" section** to showcase developer/application work, starting with
   the **Portfolio Dashboard** desktop app (current release **v0.5.3**, early-release).
   This section replaces the navigation slot freed up by removing the Knowledge Hub.
3. **Clean up the Scripts catalog** now that the VBA modules are gone.
4. **Rebuild the Portfolio Rebalancer tool** (both the in-browser tool and the
   downloadable desktop program) using the proven rebalancing logic from the Portfolio
   Dashboard app, while keeping the website tool's ticker-helper messaging that the app
   does not have. Make the desktop program one-double-click easy for non-technical users
   via a venv-creating setup batch file.

> **Naming note:** the new section is called **"Software"** with route `/software/`. The
> nav label is defined in a single place (see Phase 4) — if the owner prefers
> "Developments" or "Apps", change only that one label/permalink; the rest of the plan is
> unaffected.

---

## PHASE 1 — Remove the Finance Knowledge Hub (`/notes/`)

**Why:** unused, not updated, being replaced by the Software section.

### Steps

1.1. Delete the entire `notes/` directory and every file under it, including:
- the hub landing page (`/notes/`)
- `notes/financial-news-updates*`
- `notes/financial-knowledge*`
- `notes/advisor-analyst-resources*`

1.2. Edit `index.md` (homepage): remove the **"Knowledge Hub Highlights"** block and its
three links (Financial News & Updates, Financial Knowledge, Advisor & Analyst Resources).
Leave a clean gap — this space will be reused for a Software/featured-app callout in
Phase 3.

1.3. Grep the whole repo for stragglers and remove/repoint them:
```
grep -rin "notes/" . --include=*.md --include=*.html --include=*.yml --include=*.scss
grep -rin "knowledge hub" . -i
```
Anything that links into `/notes/...` must be removed or repointed.

1.4. Check `_config.yml` for any collection, `defaults`, or `header_pages` entry that
references `notes` and remove it.

1.5. **(Recommended) Add redirects so old links don't 404.** If the
`jekyll-redirect-from` plugin is available on GitHub Pages (it is, by default), add a
`redirect_from` to a sensible target. Otherwise create tiny stub HTML files with a meta
refresh. Map old Knowledge Hub URLs → the homepage (`/`) or the new `/software/` page.

### Acceptance check
- Site builds with no errors.
- No internal link anywhere resolves to `/notes/...`.
- Visiting an old `/notes/` URL redirects (or cleanly 404s if redirects were skipped),
  and the homepage no longer shows the Knowledge Hub block.

---

## PHASE 2 — Clean up the Scripts catalog (VBA removal)

**Why:** the 9 VBA `.bas` modules have been removed from the repo; the catalog still
advertises them.

### Steps

2.1. Confirm the VBA files are actually gone:
```
find . -name "*.bas"
ls projects/VBA_Macros_and_Functions 2>/dev/null
```
If the `VBA_Macros_and_Functions` directory still exists and is empty or orphaned, delete
it.

2.2. Edit `scripts.md`:
- Remove the entire **"VBA Scripts (Excel Utilities)"** section and its list of 9 modules.
- Update the summary stat cards at the top. Currently they read roughly
  "Python Tools — 3 active scripts" and "VBA Utilities — 9 `.bas` modules". Remove the VBA
  card. Keep the Python card and update the count to match what actually exists in the
  repo (count the `.py` files the catalog discovers).
- If the page has auto-discovery logic that scans a directory for `.bas` files, update it
  so it no longer looks for VBA or points at the deleted folder.

2.3. Update `README.md` — remove any mention of VBA modules / `VBA_Macros_and_Functions`
and make the "Site Structure" list reflect reality (it will also need a Software-section
line added in Phase 3, so you can do both README edits together at the end of Phase 3).

### Acceptance check
- `/scripts/` lists only the real Python tools, with an accurate count, and no VBA section.
- No 404 links to `.bas` files.

---

## PHASE 3 — Add the "Software" section + Portfolio Dashboard page

**Why:** showcase the Portfolio Dashboard app and create a scalable home for future
developer projects/repos.

### 3.1 Create the Software landing page

Create `software.md` at repo root, modelled on `projects.md`:
- Set an explicit `permalink: /software/` to avoid the capitalization quirk that affects
  `/Projects/`.
- Copy the front-matter shape and layout reference from `projects.md`.
- Heading + one-line intro framing it as "Applications and developer projects."
- A list of software entries (one for now). Each entry: title, one-line description, link
  to its sub-page. First entry = **Portfolio Dashboard**.
- Design it as a **scalable template** — the owner intends to add more (larger) repos here
  with their own landing pages. Leave a clearly commented "add new app entries here"
  marker.

### 3.2 Create the Portfolio Dashboard app page

Create `software/portfolio-dashboard.md`, modelled on
`projects/portfolio-rebalancer.md` (same front-matter/layout conventions). Content,
**sourced from the app's README** at https://github.com/elmatthe/portfolio-dashboard
(read it directly as the source of truth — summarize, don't copy verbatim):

- **Hero block:** name "Portfolio Dashboard", tagline "Local-first multi-broker portfolio
  tracker — 11 brokers, 10 currencies", a **version badge "v0.5.3"** and an
  **"Early release"** label.
- **What it does:** multi-broker import (CSV/TSV/XLSX/PDF, broker auto-detected),
  10-currency support with trade-date FX, CRA-compliant ACB engine, CAD-equivalent
  aggregation, SHA-256 dedupe, multi-account (14 types), multi-profile.
- **Reports:** Excel export, CRA Tax Report PDF (Schedule 3-style), Annual Portfolio
  Report PDF, JSON export.
- **Analytics:** time-period selector, per-account performance, lifetime ROI, value
  history, performance attribution, correlation matrix, portfolio statistics, dividend
  tracker.
- **Decision tools:** Rebalancing advisor, What-If simulator, price alerts.
- **Canadian-specific:** TFSA contribution-room calculator, Schedule 3 PDF.
- **Privacy:** local-first; outbound calls only to Yahoo Finance and (opt-in) Bank of
  Canada Valet API.
- **Tech stack table:** FastAPI/SQLAlchemy/SQLite/pandas backend, React+TS+Vite frontend,
  Electron desktop, PyInstaller + electron-builder packaging, pytest (113 tests).
- **Roadmap:** 0.6.0 → 1.0.0 highlights from the README.
- **Links:** GitHub repo, the v0.5.3 Release, and the installer download
  (`Portfolio Dashboard Setup 0.5.3.exe`). Include the SmartScreen "More info → Run
  anyway" note since the build isn't code-signed yet.
- **Disclaimer:** keep the same illustrative/educational, not-financial-advice disclaimer
  style used on the other project pages.

### 3.3 Add a workflow / preview graphic

The other project pages use an SVG workflow graphic in `assets/images/`
(e.g. `monte-carlo-workflow.svg`, `cpi-workflow-overview.svg`). Create a matching
`assets/images/portfolio-dashboard-overview.svg` (import → track/analyze → report) in the
same visual style, and/or wire up a screenshot placeholder block the owner can drop real
app screenshots into later (`assets/images/portfolio-dashboard-*.png`).

### 3.4 Homepage callout

In `index.md`, in the space vacated in step 1.2, add a short "Featured Application"
callout linking to `/software/portfolio-dashboard/` (title, one-liner, "early release
v0.5.3").

### 3.5 README update

Update `README.md` "Site Structure" to add the Software section
(`software.md`, `software/`) and finish the VBA removal from step 2.3.

### Acceptance check
- `/software/` renders and lists the Portfolio Dashboard.
- `/software/portfolio-dashboard/` renders with all sections, correct v0.5.3 references,
  working external links, and the overview graphic.
- Homepage shows the featured-app callout instead of the old Knowledge Hub block.

---

## PHASE 4 — Global navigation rework

**Why:** swap the "Finance Knowledge Hub" nav slot for "Software", and fix the existing
label inconsistency.

### Steps

4.1. Locate where the top nav is defined. It is likely one of:
- `_config.yml` (`header_pages:` if using the minima theme), or
- a custom `_includes/header.html` / `_layouts/*.html`.
Find the single source of truth.

4.2. Target nav order: **Projects · Scripts · Software · About**
(Software replaces the Finance Knowledge Hub link; route `/software/`).

4.3. Ensure the label/route is **identical on every page** (this fixes the
"Finance Knowledge Hub" vs "Notes" inconsistency). Grep to confirm no page hardcodes an
old nav:
```
grep -rin "Knowledge Hub\|/notes/\|>Notes<" . --include=*.html --include=*.md
```

4.4. **Fix the `/about/` redirect loop.** Decide on a single About source — keep
`about.md` (Markdown, consistent with the rest of the site) **or** `about.html`, not both.
Delete the redundant one and confirm `/about/` resolves to a real page with the owner's
profile content. If the content currently lives only in the file you're deleting, migrate
it first.

### Acceptance check
- Every page shows the same nav: Projects · Scripts · Software · About.
- `/about/` loads actual content (no redirect loop).
- No page references the old Knowledge Hub / Notes link.

---

## PHASE 5 — Rebuild the Portfolio Rebalancer

**Why:** the current rebalancer has broken behavior. Port the **proven** rebalancing logic
from the Portfolio Dashboard app, but keep the website tool's **ticker-helper messaging**
(a feature the app lacks). There are two deliverables: the **in-browser tool** and the
**downloadable desktop program**.

> **Source of truth for the math:** read the Portfolio Dashboard repo's rebalancing-advisor
> implementation (`backend/` — search for the rebalance recommender). Mirror its behavior
> exactly. The spec in **Appendix A** below is a faithful summary to follow if the source
> is unavailable, but the app code wins on any discrepancy.

### 5.0 Audit (do this first)

Open the current rebalancer implementation:
- Browser tool: the JS embedded in `projects/portfolio-rebalancer.md` (and any linked JS in
  `assets/`).
- Desktop script: `projects/Portfolio_Rebalancer/portfolio_rebalancer_desktop.py`.

Write a short list (in the PR/commit description) of exactly which features are broken or
incorrect before changing anything.

### 5.1 Track A — In-browser tool (`/projects/portfolio-rebalancer/`)

Port the app's logic into the page's JS:

1. **Two modes:** `new_money` and `rebalance` (pure). Add a clear mode toggle.
2. **Invariant 1 (new-money budget):** in `new_money` mode, total buy cost must never
   exceed the entered new-money budget; if target buys overshoot, **scale them down
   proportionally** and show a warning.
3. **Invariant 2 (rebalance funding):** in `rebalance` mode, total buy cost must never
   exceed total sell proceeds.
4. **Invariant 3 (cross-account funding):** add an **optional** per-row "Account Type"
   column. When present, sells in one account type cannot fund buys in another; surface a
   per-account-type warning when the math implies it. Keep this optional so the simple
   single-account flow still works without it.
5. **New positions:** allow rows for tickers not currently held, priced via the existing
   live-price lookup.
6. **KEEP & improve the ticker-helper message system** — the existing tool's messaging
   that helps users pick/disambiguate tickers (e.g. the "ISF not found in CNY. Found as
   ISF.L (GBP). Update row currency or ticker symbol." style guidance). The app does **not**
   have this; it is a differentiator. Preserve it and make sure it still fires with the new
   logic.
7. **Keep** the existing multi-currency + FX handling, CSV/Excel export framing, and
   spreadsheet-style input table.
8. **Fix** the validation rules so they match the new logic (no negative shares, target
   weights numeric ≥ 0, at least one target > 0, ending portfolio value > 0, etc.).
9. Update the on-page output to clearly show: per-row current value, target value,
   buy/sell/hold action, trade amount, post-trade shares, plus the mode-specific warnings.

### 5.2 Track B — Downloadable desktop program ("program stack")

Rebuild the desktop rebalancer using the same logic. **It may be more than one file** —
structure it as a small clean package, e.g. under
`projects/Portfolio_Rebalancer/`:

```
portfolio_rebalancer/
  __init__.py
  core.py          # pure rebalancing logic — the two modes + three invariants
  fx.py            # FX conversion (mirror the app's FX cascade where practical)
  pricing.py       # yfinance live price + FX lookup, with manual fallback
  ticker_helper.py # the ticker disambiguation / message system (web tool parity)
  ui.py            # tkinter GUI
  export.py        # CSV + Excel (openpyxl) export
main.py            # entry point: launches the GUI
requirements.txt   # openpyxl, yfinance, (anything else used)
```
(Adjust names sensibly; the point is a maintainable package, not one giant script. Keep
`core.py` pure and unit-testable — no GUI imports — so the logic can be tested in
isolation and matches the app's invariants.)

Behavior must match Track A and the app: two modes, three invariants, new positions via
live price, the ticker-helper messaging, multi-currency, CSV + Excel export.

### 5.3 Non-technical setup — venv batch files (Windows)

Make the desktop program one-double-click easy. Add to the program folder:

1. **`setup.bat`** — for first-time setup:
   - Check Python is installed and on PATH (clear message + link to python.org if not).
   - Create a virtual environment in the program folder (e.g. `.venv`).
   - Upgrade pip and `pip install -r requirements.txt` **into the venv**.
   - Print a clear "Setup complete — double-click run.bat to start" message.
2. **`run.bat`** — for everyday use:
   - If `.venv` is missing, call `setup.bat` first (so a user can just double-click
     `run.bat` and it self-heals).
   - Activate the venv and launch `main.py`.
   - Keep the window open on error so the user can read any message.

(Optionally provide a single combined `Setup and Run.bat` that does both, mirroring the
naming style the owner already uses in the Portfolio Dashboard repo's
`Launch Portfolio Dashboard.bat`.)

The batch files must use **relative paths** (work from wherever the user unzips the
folder) and must not require admin rights.

### 5.4 Update the rebalancer documentation

Update `projects/Portfolio_Rebalancer/Portfolio_Rebalancer_Setup_Guide.md` and its
rendered web version (`/projects/portfolio-rebalancer-guide/`) to describe the new
non-technical workflow:
- "Download the folder → double-click `setup.bat` once → double-click `run.bat`."
- Keep the existing detailed sections (inputs, modes, validation, exports) but align them
  with the rebuilt behavior.
- Update the project page download links if the desktop deliverable is now a folder/zip
  rather than a single `.py` (provide a zipped "program stack" download, or list the files
  to download together).

### Acceptance check
- Browser tool: both modes work; all three invariants hold; new positions priced; the
  ticker-helper messages still appear; validation is correct; outputs and warnings are
  clear. Manually test with the "Load Sample Portfolio" data.
- Desktop program: a clean Windows machine with only Python installed can run `setup.bat`
  then `run.bat` and reach a working GUI; a rebalance produces output matching the browser
  tool for the same inputs; CSV + Excel export work.
- `core.py` has at least a few unit tests proving the invariants (budget cap + proportional
  scaling, sell-funds-buys cap, cross-account flag).
- Setup guide (md + web) matches the new workflow.

---

## PHASE 6 — Final QA & cleanup

6.1. Full local build (`bundle exec jekyll serve`) with **zero** build warnings/errors.

6.2. Click-through every page: Home, Projects (+ all 3 project pages and their guides),
Scripts, Software (+ Portfolio Dashboard page), About. No broken internal links, no broken
images, nav identical everywhere.

6.3. Re-run the link grep to confirm no `/notes/`, "Knowledge Hub", or `.bas` references
remain anywhere.

6.4. Confirm the `.py` downloads and the rebalancer program zip/folder download correctly
from the live-style paths.

6.5. Update `README.md` one final time so "Site Structure" and "Featured Tool" sections
match the final state (Software section present, VBA gone, rebalancer described as the
new package + batch workflow).

6.6. Summarize the changes in the final commit / PR description, including the list of
rebalancer bugs found in step 5.0 and how each was fixed.

---

## Appendix A — Rebalancing logic spec (summary)

Faithful summary of the Portfolio Dashboard rebalancing advisor. **If you can read the app
repo's recommender code, that is authoritative; use this only as a backup.**

- **Inputs:** a set of holdings, each with current shares, current price, currency, and a
  **target weight** per `(ticker, account_type)`. Plus a mode and (for new money) a budget.
- **Modes:**
  - `new_money` — the user is adding cash; compute buys to move toward targets, funded by
    the budget.
  - `rebalance` — no new cash; sells fund buys.
- **Three invariants (must always hold):**
  1. **New-money budget cap:** in `new_money` mode, total buy cost ≤ `new_money_cad`
     budget. If raw target buys exceed the budget, scale all buys down **proportionally**
     and emit a warning.
  2. **Rebalance self-funding:** in `rebalance` mode, total buy cost ≤ total sell proceeds.
  3. **Cross-account funding flag:** funds cannot move between account types (e.g. a TFSA
     sell cannot fund a Margin buy). When the recommended trades would imply cross-account
     funding, emit a per-account-type warning rather than silently moving money.
- **New positions:** tickers not currently held are allowed; fetch a live price for them.
- **Output per holding:** current value, target value, trade value (reporting currency +
  local currency), trade shares, action (Buy/Sell/Hold), post-trade shares; plus the
  summary totals and any warnings.

**Website-only addition (not in the app):** the **ticker-helper message system** that
guides users when a ticker can't be found in the chosen currency/market and suggests the
correct symbol/suffix (e.g. `.TO`, `.L`, `.T`). Preserve this in both the browser tool and
the desktop program (`ticker_helper.py`).

---

## Appendix B — Portfolio Dashboard quick facts (for the app page)

- **Version:** v0.5.3 (stable release, May 2026). Early-release stage.
- **Tagline:** Local-first multi-broker portfolio tracker — 11 brokers, 10 currencies.
- **Brokers (11):** Questrade, Wealthsimple, RBC Direct Investing, CIBC Investor's Edge,
  TD Direct Investing, BMO InvestorLine, Scotia iTRADE, Interactive Brokers, National Bank
  Direct Brokerage, Fidelity, HSBC InvestDirect.
- **Currencies (10):** CAD, USD, GBP, EUR, JPY, AUD, CHF, HKD, SEK, NOK.
- **Stack:** FastAPI · SQLAlchemy · SQLite · pandas · openpyxl · pdfplumber · reportlab ·
  matplotlib (backend); React 18 · TypeScript · Vite · TanStack Query · Tailwind ·
  Recharts (frontend); Electron 30 (desktop); PyInstaller + electron-builder (packaging);
  pytest, 113 tests.
- **Privacy:** local-first; outbound only to Yahoo Finance (+ opt-in Bank of Canada Valet
  API for FX).
- **License:** MIT.
- **Repo:** https://github.com/elmatthe/portfolio-dashboard
- **Release:** https://github.com/elmatthe/portfolio-dashboard/releases/tag/v0.5.3

---

## Phase checklist (track progress)

- [ ] Phase 1 — Finance Knowledge Hub (`/notes/`) removed
- [ ] Phase 2 — Scripts catalog VBA cleanup
- [ ] Phase 3 — Software section + Portfolio Dashboard page
- [ ] Phase 4 — Navigation reworked, `/about/` loop fixed
- [ ] Phase 5 — Rebalancer rebuilt (browser + desktop + venv batch + docs)
- [ ] Phase 6 — Final QA & README sync
