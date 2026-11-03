// Instrument identity: turns what a user typed ("VEQT.TO", "YNVD.TO", "AAPL") into a
// ResolvedInstrument (md.instrument.v1) WITHOUT any network request.
//
// A price is only ever attached to a resolved instrument (venue + local symbol +
// quote currency + unit), never to the text in a ticker box. Resolution order:
//   1. the curated reference (assets/data/instruments.v1.json): identity facts with
//      sources, including broker display aliases such as Questrade's "YNVD.TO" for a
//      Cboe Canada ETF. The user's text is kept exactly; only the internal identity
//      is mapped.
//   2. the exchange suffix (".TO" -> Toronto Stock Exchange, ".L" -> London, ...).
//      The currency this implies is only a HINT ("venue_default_unconfirmed"): a
//      provider must confirm it before the price can be used in a plan.
//   3. a bare symbol is taken as a US listing, also unconfirmed until a provider
//      that serves only US listings returns it.
// Indexes, FX pairs and futures are recognised and reported as unsupported for
// holdings. Nothing here guesses a different market when a symbol is not found.

export const INSTRUMENT_SCHEMA = "md.instrument.v1";

// Exchange prefixes some sites use ("TSX:RY"). TSE: is Google Finance's Toronto prefix.
const PREFIXES = { "TSX:": ".TO", "TSE:": ".TO", "TSXV:": ".V", "CVE:": ".V", "NEO:": ".NE", "LSE:": ".L", "LON:": ".L", "JPX:": ".T", "TYO:": ".T", "ETR:": ".DE", "SHA:": ".SS", "SHE:": ".SZ", "HKG:": ".HK" };
const SYMBOL = /^\^?[A-Z0-9](?:[A-Z0-9-]|\.(?=[A-Z0-9])){0,19}(?:=X|=F)?$/;

const clean = value => String(value ?? "").trim().toUpperCase();

export function createInstrumentResolver(reference) {
  if (!reference || reference.schema !== "md.instrument-reference.v1") throw new Error("instrument reference missing or of the wrong version");
  const venues = reference.venues || {};
  const byAlias = new Map();
  const byId = new Map();
  for (const entry of reference.instruments || []) {
    byId.set(entry.id, entry);
    for (const alias of entry.aliases || []) byAlias.set(clean(alias), entry);
  }
  // Longest suffix first so ".NEO" wins over ".NE".
  const suffixes = Object.entries(venues)
    .flatMap(([mic, v]) => (v.suffixes || []).filter(Boolean).map(suffix => ({ suffix, mic })))
    .sort((a, b) => b.suffix.length - a.suffix.length);

  const venueOf = mic => venues[mic] || null;
  const unitScale = unit => (unit === "minor" ? 0.01 : 1);

  function base(displayTicker) {
    return { schema: INSTRUMENT_SCHEMA, displayTicker, canonicalId: null, localSymbol: null, mic: null, venueName: null, country: null, timeZone: null, name: null, issuer: null, instrumentType: "unknown", currency: null, quoteUnit: "major", unitScale: 1, currencyEvidence: null, source: null, verifiedAt: null, listedFrom: null, notes: [], evidence: [], status: "unresolved", reason: null };
  }

  function fromCurated(displayTicker, entry) {
    const venue = venueOf(entry.mic);
    const notes = [...(entry.notes || [])];
    const aliasNote = entry.aliasNotes?.[displayTicker];
    if (aliasNote) notes.unshift(aliasNote);
    return {
      ...base(displayTicker),
      canonicalId: entry.id, localSymbol: entry.localSymbol, mic: entry.mic, venueName: venue?.name || entry.mic,
      country: venue?.country || null, timeZone: venue?.timeZone || null, name: entry.name, issuer: entry.issuer || null, instrumentType: entry.type || "unknown",
      currency: entry.currency, quoteUnit: entry.quoteUnit || "major", unitScale: unitScale(entry.quoteUnit),
      currencyEvidence: "curated_reference", source: "curated", verifiedAt: entry.verifiedAt || null, listedFrom: entry.listedFrom || null,
      notes, evidence: entry.evidence || [], status: "resolved", referenceVersion: reference.version,
    };
  }

  function fromVenue(displayTicker, local, mic, { currency = null, reason = null } = {}) {
    const venue = venueOf(mic);
    return {
      ...base(displayTicker),
      canonicalId: `${mic}:${local}`, localSymbol: local, mic, venueName: venue?.name || mic, country: venue?.country || null, timeZone: venue?.timeZone || null,
      currency: currency || venue?.currency || null, quoteUnit: currency ? "major" : (venue?.quoteUnit || "major"),
      unitScale: currency ? 1 : unitScale(venue?.quoteUnit), currencyEvidence: "venue_default_unconfirmed",
      source: "suffix", status: "resolved", reason,
      notes: venue?.currencyRule ? [venue.currencyRule] : venue?.note ? [venue.note] : [],
    };
  }

  // Resolves one ticker as typed. Never throws for user input: problems come back
  // as status "invalid" / "unsupported" / "unresolved" with a reason.
  function resolve(input) {
    let text = clean(input);
    const displayTicker = text;
    if (!text) return { ...base(displayTicker), status: "empty", reason: "Enter a ticker." };
    for (const [prefix, suffix] of Object.entries(PREFIXES)) {
      if (text.startsWith(prefix)) { text = text.slice(prefix.length).trim() + suffix; break; }
    }
    if (!SYMBOL.test(text)) return { ...base(displayTicker), status: "invalid", reason: `"${displayTicker.slice(0, 24)}" is not a valid ticker symbol.` };
    const curated = byAlias.get(displayTicker) || byAlias.get(text);
    if (curated) return fromCurated(displayTicker, curated);
    if (text.startsWith("^")) return { ...base(displayTicker), instrumentType: "index", status: "unsupported", reason: "Market indexes cannot be held. Enter the ETF or fund you own instead." };
    if (text.endsWith("=X")) return { ...base(displayTicker), instrumentType: "fx", status: "unsupported", reason: "Currency pairs are not holdings here; exchange rates come from the Bank of Canada or the ECB." };
    if (text.endsWith("=F")) return { ...base(displayTicker), instrumentType: "future", status: "unsupported", reason: "Futures contracts are not supported." };
    // TSX US-dollar units: Yahoo-style "DLR-U.TO" / "DLR.U.TO".
    const usdUnit = /^(.+?)[-.]U\.TO$/.exec(text);
    if (usdUnit) return fromVenue(displayTicker, `${usdUnit[1]}.U`, "XTSE", { currency: "USD", reason: "TSX US-dollar unit (.U)" });
    const match = suffixes.find(s => text.endsWith(s.suffix) && text.length > s.suffix.length);
    if (match) return fromVenue(displayTicker, text.slice(0, -match.suffix.length), match.mic);
    const dot = text.lastIndexOf(".");
    if (dot > 0) {
      const suffix = text.slice(dot);
      // US class shares (BRK.B, BF.B): a single letter after the dot that is not a known exchange suffix.
      if (/^\.[A-Z]$/.test(suffix)) return { ...fromVenue(displayTicker, text, "US"), reason: "US share class" };
      return { ...base(displayTicker), status: "unresolved", reason: `Unknown exchange suffix "${suffix}". Use a Yahoo-style suffix such as .TO (Toronto), .NE (Cboe Canada), .L (London) or .DE (Xetra).` };
    }
    return fromVenue(displayTicker, text, "US");
  }

  return {
    resolve,
    venue: venueOf,
    byId: id => byId.get(id) || null,
    get version() { return reference.version; },
    get venues() { return venues; },
  };
}

// Loads the curated reference that ships with the site (identity facts only).
export async function loadInstrumentReference({ fetchImpl = (...a) => globalThis.fetch(...a), url = new URL("../../data/instruments.v1.json", import.meta.url).href } = {}) {
  const res = await fetchImpl(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`instrument reference unavailable (HTTP ${res.status})`);
  return res.json();
}
