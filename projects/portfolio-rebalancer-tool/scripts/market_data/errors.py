"""DataError: one error type for every provider, mirroring http.js DataError."""
from __future__ import annotations

RETRYABLE_KINDS = {"network", "timeout", "unavailable", "provider_notice"}


class DataError(Exception):
    """A market-data failure the UI can explain.

    kind: network | timeout | http | rate_limited | invalid | not_found | aborted | auth |
          unavailable | not_configured | key_changed | entitlement | not_covered |
          ambiguous | currency_mismatch | provider_notice | budget_withheld
    rate_limited carries quota_scope: burst | minute | daily | monthly | unknown.
    """

    def __init__(self, message: str, *, kind: str = "network", status: int | None = None, definitive: bool = False,
                 provider: str | None = None, retry_after_ms: int | None = None, quota_scope: str | None = None,
                 notice: str | None = None, hint: str | None = None, instrument: str | None = None,
                 retryable: bool | None = None, paused: bool = False, gateway_code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.kind = kind
        self.status = status
        self.definitive = definitive
        self.provider = provider
        self.retry_after_ms = retry_after_ms
        self.quota_scope = quota_scope
        self.notice = notice
        self.hint = hint
        self.instrument = instrument
        self._retryable = retryable
        self.paused = paused  # nothing was sent: the source is pausing after a "slow down" or an outage
        self.gateway_code = gateway_code  # the data gateway's own error code, when it answered
        self.attempts: list[dict] = []
        self.skipped: list[dict] = []

    def __str__(self) -> str:
        return self.message

    @property
    def retryable(self) -> bool:
        if self._retryable is not None:
            return self._retryable
        if self.definitive:
            return False
        if self.kind == "rate_limited":
            return self.quota_scope not in ("daily", "monthly")
        return self.kind in RETRYABLE_KINDS

    def to_contract(self) -> dict:
        kind = f"quota_{self.quota_scope or 'unknown'}" if self.kind == "rate_limited" else ("cancelled" if self.kind == "aborted" else self.kind)
        return {
            "schema": "md.data-error.v1",
            "kind": kind,
            "provider": self.provider,
            "affectedInstrument": self.instrument,
            "retryable": self.retryable,
            "retryAfterMs": self.retry_after_ms,
            "redactedNotice": self.notice,
            "resolutionHint": self.hint,
            "quotaScope": self.quota_scope,
            "message": self.message,
        }
