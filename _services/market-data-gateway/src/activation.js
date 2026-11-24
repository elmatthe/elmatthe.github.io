// Whether the keyless source may be used. Shared by the Worker (every data request) and the
// coordinator (an owner's incident approval is accepted only while the source is off, M4).
import { SOURCE_ID } from "./yahoo-chart.js";

// The exact value of OWNER_ATTESTATION that switches the source on (with KEYLESS_SOURCE).
export const OWNER_ATTESTATION_VALUE = "owner-confirms-yahoo-permission";

// Whether the keyless source may be used, and why not. Both settings are required.
export function sourceState(env = {}) {
  const configured = String(env.KEYLESS_SOURCE ?? "").trim();
  const attestation = String(env.OWNER_ATTESTATION ?? "").trim();
  if (!configured || configured === "none" || configured === "off") {
    return { enabled: false, source: "none", activation: null, reason: "The keyless source is switched off on this gateway (KEYLESS_SOURCE is not set)." };
  }
  if (configured !== SOURCE_ID) return { enabled: false, source: "none", activation: null, reason: "An unknown keyless source is configured; it stays switched off." };
  if (attestation !== OWNER_ATTESTATION_VALUE) {
    return { enabled: false, source: SOURCE_ID, activation: null, reason: "Yahoo Finance retrieval is switched off: the operator has not activated it on this gateway (OWNER_ATTESTATION is not set)." };
  }
  return { enabled: true, source: SOURCE_ID, activation: "owner_attestation", reason: null };
}
