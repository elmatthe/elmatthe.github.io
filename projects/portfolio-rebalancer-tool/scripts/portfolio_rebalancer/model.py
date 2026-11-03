"""Desktop planning model: holdings, prices, readiness and the plan, without any GUI.

Mirrors the web app (assets/js/portfolio-rebalancer/app.js and rows.js):
  * a holding is ticker + shares + target % (+ optional account type);
  * committing a ticker resolves it locally (no request) to one listing and currency;
    a price is fetched for that listing only, from the chosen source;
  * editing a ticker clears that holding's price at once; each request carries a
    token (row id, revision, instrument) and a late answer is ignored;
  * a plan exists only when every holding with shares or a target has a verified
    price in a confirmed currency, or a price the user deliberately supplied.
"""
from __future__ import annotations

import datetime as dt
import itertools
import time
from dataclasses import dataclass, field

from market_data.freshness import freshness_of
from portfolio_rebalancer import core

ACCOUNT_TYPES = ["", "TFSA", "RRSP", "RESP", "RRIF", "FHSA", "LIRA", "Margin", "Non-Registered", "Individual", "Crypto", "Other"]
REPORTING = ["CAD", "USD", "EUR", "GBP", "JPY", "CNY", "HKD", "CHF", "AUD"]
PRICE_TYPE = {"latest_trading_day": "latest price for trading day", "eod_close": "close", "previous_close": "previous close", "last_trade": "last price"}
SYMBOLS = {"CAD": "C$", "USD": "US$", "EUR": "€", "GBP": "£", "JPY": "¥", "CNY": "CN¥", "HKD": "HK$", "AUD": "A$", "CHF": "CHF "}
ZERO_DECIMALS = {"JPY", "KRW", "IDR"}
DISCLAIMER = "Illustrative planning only; not financial, investment, or trading advice. Verify prices and holdings at your broker before trading."
_ids = itertools.count(1)


def money(value: float, currency: str) -> str:
    decimals = 0 if currency in ZERO_DECIMALS else 2
    sign = "-" if value < 0 else ""
    return f"{sign}{SYMBOLS.get(currency, currency + ' ')}{abs(value):,.{decimals}f}"


def qty(value: float) -> str:
    return f"{value:,.4f}".rstrip("0").rstrip(".")


@dataclass
class Row:
    ticker: str = ""
    shares: str = ""
    target: str = ""
    account: str = ""
    group: str = "main"
    id: str = field(default_factory=lambda: f"r{next(_ids)}")
    revision: int = 0
    status: str = "empty"
    identity: dict | None = None
    quote: dict | None = None
    error: dict | None = None
    manual: dict | None = None
    committed: str | None = None

    def __post_init__(self) -> None:
        self.ticker = str(self.ticker or "").strip().upper()
        self.shares = "" if self.shares is None else str(self.shares)
        self.target = "" if self.target is None else str(self.target)
        if self.ticker and self.status == "empty":
            self.status = "draft"

    # ---------------------------------------------------------------- state changes
    def edit_ticker(self, text: str) -> bool:
        ticker = str(text or "").strip().upper()
        if ticker == self.ticker:
            return False
        self.ticker = ticker
        self.revision += 1
        self.status = "draft" if ticker else "empty"
        self.identity = self.quote = self.error = self.manual = None
        self.committed = None
        return True

    def apply_identity(self, identity: dict) -> None:
        if identity["displayTicker"] != self.ticker:
            return
        self.identity = identity
        self.status = identity["status"] if identity["status"] != "empty" else "empty"
        self.error = None
        self.committed = self.ticker

    def reset_quote(self) -> None:
        if self.quote or self.error or self.status == "pricing":
            self.revision += 1
            self.quote = self.error = None
            self.status = "resolved" if self.identity and self.identity["status"] == "resolved" else self.status

    def token(self) -> tuple:
        return (self.id, self.revision, (self.identity or {}).get("canonicalId"))

    def token_matches(self, token: tuple) -> bool:
        return token == self.token()

    def apply_quote(self, token: tuple, quote: dict) -> bool:
        if not self.token_matches(token) or quote.get("canonicalId") != (self.identity or {}).get("canonicalId"):
            return False
        self.quote, self.error, self.status = quote, None, "priced"
        return True

    def apply_error(self, token: tuple, error: dict) -> bool:
        if not self.token_matches(token):
            return False
        self.quote, self.error = None, error
        self.status = "not_covered" if error.get("kind") in ("not_covered", "not_configured") else "failed"
        return True

    def set_manual(self, price: object, currency: str, unit_scale: float = 1.0, kind: str = "manual", label: str | None = None) -> None:
        value = core.parse_number(price)
        if value is None or value <= 0:
            raise ValueError("Enter a price greater than 0.")
        if not (isinstance(currency, str) and len(currency) == 3 and currency.isalpha() and currency.isupper()):
            raise ValueError("Choose the currency the price is in.")
        self.manual = {"price": value * unit_scale, "enteredPrice": value, "currency": currency, "unitScale": unit_scale, "kind": kind,
                       "label": label or ("Imported from CSV (user-supplied)" if kind == "csv" else "Entered by you (user-supplied)"),
                       "at": time.time()}

    # ---------------------------------------------------------------- views
    @property
    def active(self) -> bool:
        return not (self.shares != "" and self.target != "" and core.parse_number(self.shares) == 0 and core.parse_number(self.target) == 0)

    def effective(self) -> dict | None:
        if self.manual:
            return {"price": self.manual["price"], "currency": self.manual["currency"],
                    "source": {"kind": self.manual["kind"], "label": self.manual["label"], "currencyVerified": False, "freshness": "current", "tradingDate": None}}
        if self.quote and self.status == "priced":
            q = self.quote
            return {"price": q["nativePriceMajorUnits"], "currency": q["nativeCurrency"],
                    "source": {"kind": "provider", "provider": q["provider"], "currencyVerified": q.get("currencyVerified") is True,
                               "tradingDate": q.get("tradingDate"), "label": quote_label(q)}}
        return None

    def valuation_row(self, now: float, fx_available) -> dict:
        eff = self.effective()
        source = dict(eff["source"]) if eff else {}
        if eff and source["kind"] == "provider":
            source["freshness"] = freshness_of(source.get("tradingDate"), now, (self.identity or {}).get("timeZone"))[0]
        problem = None
        if not eff:
            if not self.ticker:
                problem = "ticker missing"
            elif self.status == "pricing":
                problem = "price is being fetched"
            elif self.error:
                problem = self.error.get("message") or self.error.get("kind")
            elif self.identity and self.identity.get("status") != "resolved":
                problem = self.identity.get("reason") or self.identity.get("status")
            else:
                problem = "no price yet"
        return {"rowId": self.id, "ticker": self.ticker, "shares": self.shares, "targetWeight": self.target,
                "price": eff["price"] if eff else None, "currency": eff["currency"] if eff else None,
                "fxAvailable": fx_available(eff["currency"]) if eff else False, "source": source, "problem": problem}


def quote_label(q: dict) -> str:
    return f"{q['provider']} · {PRICE_TYPE.get(q['priceType'], q['priceType'])} {q.get('tradingDate') or ''}".strip()


def rows_from_sample(sample: dict) -> list[Row]:
    return [Row(r["ticker"], str(r["shares"]), str(r["targetWeight"]), r.get("accountType", ""), r.get("group", "main")) for r in sample["rows"]]


@dataclass
class Settings:
    reporting: str = "CAD"
    mode: str = "new_money"
    budget: str = "3000"
    whole_shares: bool = False
    show_accounts: bool = False
    accept_stale: bool = False


def build_plan(rows: list[Row], settings: Settings, fx: dict[str, dict], now: float | None = None) -> dict:
    """Readiness, and the plan when ready. fx: {CODE: {"cadPer", "kind", "label"}} with CAD = 1.

    Returns {"valuation", "plan" | None, "whole" | None, "notes" (attention, info), "error" | None}.
    """
    now = time.time() if now is None else now
    rep = settings.reporting

    def fx_available(code: str | None) -> bool:
        return bool(code and code in fx and rep in fx)

    valuation = core.assess_valuation([r.valuation_row(now, fx_available) for r in rows], settings.accept_stale)
    out = {"valuation": valuation, "plan": None, "whole": None, "error": None, "notes": {"attention": [], "info": []}, "rows": [], "notValued": []}
    if not valuation["ready"]:
        return out
    budget = core.parse_number(settings.budget)
    if settings.mode == "new_money" and not (budget and budget > 0):
        out["error"] = "Enter a New Money budget greater than 0."
        return out
    not_valued = {n["rowId"] for n in valuation["notValued"]}
    active = [r for r in rows if r.id not in not_valued]
    cad_per = {code: v["cadPer"] for code, v in fx.items()}
    positions = []
    for i, r in enumerate(active):
        eff = r.effective()
        fx_rate = cad_per[eff["currency"]] / cad_per[rep]
        shares = core.parse_number(r.shares)
        positions.append({"rowIndex": i, "ticker": r.ticker, "shares": shares, "price": eff["price"], "currencyKey": eff["currency"],
                          "currencyLabel": eff["currency"], "targetWeight": core.parse_number(r.target),
                          "accountType": r.account if settings.show_accounts else "", "fxToReporting": fx_rate,
                          "currentValue": shares * eff["price"] * fx_rate})
    try:
        summary, results, warnings = core.calculate_rebalance_plan(positions, settings.mode, budget or 0.0, money=lambda v: money(v, rep))
    except ValueError as error:
        out["error"] = str(error)
        return out
    whole = core.apply_whole_shares(summary, results) if settings.whole_shares else None
    out.update(plan={"summary": summary, "results": results, "warnings": warnings}, whole=whole, rows=active,
               notValued=[r for r in rows if r.id in not_valued], positions=positions, fx=fx, at=now, settings=settings)
    out["notes"] = plan_notes(out)
    return out


def plan_notes(run: dict) -> dict:
    attention, info = [], []
    rep = run["settings"].reporting
    manual = [r.ticker for r in run["rows"] if r.effective()["source"]["kind"] != "provider"]
    if manual:
        attention.append(f"User-supplied prices (not verified by a provider): {', '.join(manual)}.")
    if run["valuation"]["stale"]:
        attention.append("Older prices accepted: " + ", ".join(f"{s['ticker']} ({s.get('tradingDate') or 'date unknown'})" for s in run["valuation"]["stale"]) + ".")
    manual_fx = sorted({p["currencyKey"] for p in run["positions"] if p["currencyKey"] != rep and run["fx"].get(p["currencyKey"], {}).get("kind") == "manual"})
    if manual_fx:
        attention.append(f"Exchange rates you entered: {', '.join(manual_fx)}.")
    for w in run["plan"]["warnings"]:
        (info if ("scaled down" in w or "No sells are needed" in w) else attention).append(w)
    info += core.weight_warnings(run["positions"])
    for r in run["rows"]:
        if r.quote and r.quote.get("fallbackFrom"):
            info.append(f"{r.ticker}: priced by {r.quote['provider']} because {', '.join(f['provider'] for f in r.quote['fallbackFrom'])} could not.")
    pence = [r.ticker for r in run["rows"] if r.quote and r.quote.get("quoteUnit") == "minor"]
    if pence:
        info.append(f"{', '.join(pence)}: quoted in pence and converted to pounds (÷100).")
    cash = run["whole"]["cashLeft"] if run["whole"] else run["plan"]["summary"]["cashLeft"]
    if cash > 0.005:
        what = "of the budget is not invested" if run["settings"].mode == "new_money" else "of sell proceeds is not reinvested"
        info.append(f"{money(cash, rep)} {what}{' after rounding to whole shares' if run['whole'] else ''}.")
    if not run["whole"]:
        info.append("Trade shares are fractional. If your broker trades whole shares only, choose Whole shares.")
    return {"attention": attention, "info": info}


def action_lines(run: dict) -> list[dict]:
    """One line per holding in the plan: what to do and the weights before and after."""
    s = run["plan"]["summary"]
    whole = run["whole"]
    results = whole["results"] if whole else run["plan"]["results"]
    post_total = s["totalCurrent"] + ((whole["totalBuys"] - whole["totalSells"]) if whole else (s["totalBuys"] - s["totalSells"]))
    out = []
    for r in results:
        action = r["wholeAction"] if whole else r["action"]
        shares = r["wholeShares"] if whole else r["tradeShares"]
        value = r["wholeTradeValue"] if whole else r["tradeValue"]
        local = r["wholeTradeValueLocal"] if whole else r["tradeValueLocal"]
        post = r["wholePostTradeShares"] if whole else r["postTradeShares"]
        out.append({"row": run["rows"][r["rowIndex"]], "result": r, "action": action, "shares": shares, "value": value, "local": local, "post": post,
                    "before": r["currentValue"] / s["totalCurrent"] if s["totalCurrent"] else 0.0,
                    "after": (r["currentValue"] + value) / post_total if post_total else 0.0})
    order = {"Buy": 0, "Sell": 1, "Hold": 2}
    out.sort(key=lambda x: (order[x["action"]], -abs(x["value"])))
    return out


def export_table(run: dict) -> list[list]:
    rep = run["settings"].reporting
    whole = run["whole"]
    results = whole["results"] if whole else run["plan"]["results"]
    header = ["Ticker (as entered)", "Listing", "Instrument", "Account type", "Currency", "Shares", "Price (local)", "Price source", "Provider symbol",
              "Price type", "Trading date", "Retrieved at (UTC)", "Currency evidence", f"FX to {rep}", "FX source", f"Current value ({rep})", "Target weight",
              f"Target value ({rep})", "Action", f"Trade value ({rep})", "Trade value (local)", "Trade shares", "Post-trade shares"]
    body = []
    for r in results:
        row = run["rows"][r["rowIndex"]]
        q = None if row.manual else row.quote
        source = f"{q['provider']} (provider)" if q else row.manual["label"]
        retrieved = q["retrievedAt"] if q else dt.datetime.fromtimestamp(row.manual["at"], dt.timezone.utc).isoformat().replace("+00:00", "Z")
        fx_source = "reporting currency" if r["currencyKey"] == rep else run["fx"][r["currencyKey"]].get("label", "")
        body.append([r["ticker"], (row.identity or {}).get("canonicalId", ""), (row.identity or {}).get("name") or "", r.get("accountType", ""),
                     r["currencyKey"], r["shares"], r["price"], source, q["providerSymbol"] if q else "",
                     PRICE_TYPE.get(q["priceType"], q["priceType"]) if q else "user-supplied", (q or {}).get("tradingDate") or "", retrieved,
                     q["currencyEvidence"] if q else "user", r["fxToReporting"], fx_source, r["currentValue"], r["targetWeightNorm"], r["targetValue"],
                     r["wholeAction"] if whole else r["action"], r["wholeTradeValue"] if whole else r["tradeValue"],
                     r["wholeTradeValueLocal"] if whole else r["tradeValueLocal"], r["wholeShares"] if whole else r["tradeShares"],
                     r["wholePostTradeShares"] if whole else r["postTradeShares"]])
    return [header, *body]


def export_meta(run: dict) -> list[list]:
    s = run["plan"]["summary"]
    whole = run["whole"]
    manual = len(run["valuation"]["manualOverrides"])
    rows = [["Portfolio Rebalancer — desktop export"],
            ["Generated at (UTC)", dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")],
            ["Plan calculated at (UTC)", dt.datetime.fromtimestamp(run["at"], dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")],
            ["Mode", "New Money" if s["mode"] == "new_money" else "Rebalance"],
            ["Reporting currency", run["settings"].reporting],
            ["Share quantities", "Whole shares" if whole else "Fractional shares"],
            ["Prices", f"Includes {manual} user-supplied price(s); the rest verified by providers" if manual else "All verified by providers"],
            ["Total current", s["totalCurrent"]], ["Target pool", s["pool"]],
            ["Total buys", whole["totalBuys"] if whole else s["totalBuys"]], ["Total sells", whole["totalSells"] if whole else s["totalSells"]]]
    if s["mode"] == "new_money":
        rows.append(["New money budget", s["budget"]])
    rows.append(["Cash not invested", whole["cashLeft"] if whole else s["cashLeft"]])
    return rows


def export_fx(run: dict) -> list[list]:
    rep = run["settings"].reporting
    codes = sorted({p["currencyKey"] for p in run["positions"]} - {rep})
    return [["Currency", f"{rep} per unit", "Source"]] + [[c, run["fx"][c]["cadPer"] / run["fx"][rep]["cadPer"],
                                                         "Entered by you" if run["fx"][c].get("kind") == "manual" else run["fx"][c].get("label", "")] for c in codes]
