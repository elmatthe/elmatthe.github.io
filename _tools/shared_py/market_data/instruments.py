"""Instrument identity without network requests; mirrors assets/js/market-data/instruments.js.

Order: the curated reference (instruments.v1.json, identity facts only, including
broker display aliases such as Questrade's "YNVD.TO" for a Cboe Canada ETF), then
the exchange suffix (currency marked unconfirmed), then a bare symbol as a US
listing (also unconfirmed). The typed text is always kept as displayTicker.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

INSTRUMENT_SCHEMA = "md.instrument.v1"
REFERENCE_PATH = Path(__file__).with_name("instruments.v1.json")

_PREFIXES = {"TSX:": ".TO", "TSE:": ".TO", "TSXV:": ".V", "CVE:": ".V", "NEO:": ".NE", "LSE:": ".L", "LON:": ".L", "JPX:": ".T",
             "TYO:": ".T", "ETR:": ".DE", "SHA:": ".SS", "SHE:": ".SZ", "HKG:": ".HK"}
_SYMBOL = re.compile(r"^\^?[A-Z0-9](?:[A-Z0-9-]|\.(?=[A-Z0-9])){0,19}(?:=X|=F)?$")


def load_reference(path: Path | str | None = None) -> dict:
    return json.loads(Path(path or REFERENCE_PATH).read_text(encoding="utf-8"))


class InstrumentResolver:
    def __init__(self, reference: dict | None = None) -> None:
        reference = reference or load_reference()
        if reference.get("schema") != "md.instrument-reference.v1":
            raise ValueError("instrument reference missing or of the wrong version")
        self.reference = reference
        self.venues: dict = reference.get("venues", {})
        self.by_alias: dict[str, dict] = {}
        for entry in reference.get("instruments", []):
            for alias in entry.get("aliases", []):
                self.by_alias[alias.strip().upper()] = entry
        self.suffixes = sorted(((s, mic) for mic, v in self.venues.items() for s in v.get("suffixes", []) if s),
                               key=lambda x: -len(x[0]))

    @property
    def version(self) -> str:
        return self.reference.get("version", "")

    @staticmethod
    def _base(display: str) -> dict:
        return {"schema": INSTRUMENT_SCHEMA, "displayTicker": display, "canonicalId": None, "localSymbol": None, "mic": None,
                "venueName": None, "country": None, "timeZone": None, "name": None, "issuer": None, "instrumentType": "unknown",
                "currency": None, "quoteUnit": "major", "unitScale": 1.0, "currencyEvidence": None, "source": None,
                "verifiedAt": None, "listedFrom": None, "notes": [], "evidence": [], "status": "unresolved", "reason": None}

    def _curated(self, display: str, entry: dict) -> dict:
        venue = self.venues.get(entry["mic"], {})
        notes = list(entry.get("notes", []))
        alias_note = (entry.get("aliasNotes") or {}).get(display)
        if alias_note:
            notes.insert(0, alias_note)
        unit = entry.get("quoteUnit", "major")
        return {**self._base(display), "canonicalId": entry["id"], "localSymbol": entry["localSymbol"], "mic": entry["mic"],
                "venueName": venue.get("name", entry["mic"]), "country": venue.get("country"), "timeZone": venue.get("timeZone"),
                "name": entry.get("name"), "issuer": entry.get("issuer"), "instrumentType": entry.get("type", "unknown"),
                "currency": entry.get("currency"), "quoteUnit": unit, "unitScale": 0.01 if unit == "minor" else 1.0,
                "currencyEvidence": "curated_reference", "source": "curated", "verifiedAt": entry.get("verifiedAt"),
                "listedFrom": entry.get("listedFrom"), "notes": notes, "evidence": entry.get("evidence", []), "status": "resolved",
                "referenceVersion": self.version}

    def _venue(self, display: str, local: str, mic: str, currency: str | None = None, reason: str | None = None) -> dict:
        venue = self.venues.get(mic, {})
        unit = "major" if currency else venue.get("quoteUnit", "major")
        notes = [venue["currencyRule"]] if venue.get("currencyRule") else ([venue["note"]] if venue.get("note") else [])
        return {**self._base(display), "canonicalId": f"{mic}:{local}", "localSymbol": local, "mic": mic, "venueName": venue.get("name", mic),
                "country": venue.get("country"), "timeZone": venue.get("timeZone"), "currency": currency or venue.get("currency"),
                "quoteUnit": unit, "unitScale": 0.01 if unit == "minor" else 1.0, "currencyEvidence": "venue_default_unconfirmed",
                "source": "suffix", "status": "resolved", "reason": reason, "notes": notes}

    def resolve(self, value: object) -> dict:
        text = str(value if value is not None else "").strip().upper()
        display = text
        if not text:
            return {**self._base(display), "status": "empty", "reason": "Enter a ticker."}
        for prefix, suffix in _PREFIXES.items():
            if text.startswith(prefix):
                text = text[len(prefix):].strip() + suffix
                break
        if not _SYMBOL.match(text):
            return {**self._base(display), "status": "invalid", "reason": f'"{display[:24]}" is not a valid ticker symbol.'}
        curated = self.by_alias.get(display) or self.by_alias.get(text)
        if curated:
            return self._curated(display, curated)
        if text.startswith("^"):
            return {**self._base(display), "instrumentType": "index", "status": "unsupported", "reason": "Market indexes cannot be held. Enter the ETF or fund you own instead."}
        if text.endswith("=X"):
            return {**self._base(display), "instrumentType": "fx", "status": "unsupported", "reason": "Currency pairs are not holdings here; exchange rates come from the Bank of Canada or the ECB."}
        if text.endswith("=F"):
            return {**self._base(display), "instrumentType": "future", "status": "unsupported", "reason": "Futures contracts are not supported."}
        unit_match = re.match(r"^(.+?)[-.]U\.TO$", text)
        if unit_match:
            return self._venue(display, f"{unit_match.group(1)}.U", "XTSE", currency="USD", reason="TSX US-dollar unit (.U)")
        for suffix, mic in self.suffixes:
            if text.endswith(suffix) and len(text) > len(suffix):
                return self._venue(display, text[: -len(suffix)], mic)
        dot = text.rfind(".")
        if dot > 0:
            suffix = text[dot:]
            if re.fullmatch(r"\.[A-Z]", suffix):
                return {**self._venue(display, text, "US"), "reason": "US share class"}
            return {**self._base(display), "status": "unresolved",
                    "reason": f'Unknown exchange suffix "{suffix}". Use a Yahoo-style suffix such as .TO (Toronto), .NE (Cboe Canada), .L (London) or .DE (Xetra).'}
        return self._venue(display, text, "US")
