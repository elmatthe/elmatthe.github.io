# Decisions

Why non-obvious choices were made, so they are not undone by accident. Append only.

## 2026-11-04: the market-data gateway's upstream coordinator (PR 46)

An independent review showed that per-isolate queues and a Cache API cooldown cannot give the
guarantees the gateway documents: an overdue request could start, and one isolate could overwrite
another's longer stop.

- **The coordinator makes the upstream request itself; it does not grant permission.** A Worker
  holding a permission can resume late and start after a stop was recorded, the same failure as an
  overdue timer. Decision, write and `fetch()` in one synchronous step inside one object leaves no
  such gap. Consequence: all Yahoo traffic leaves from the object's location, and the Worker
  isolates contain no upstream code at all.
- **Spacing, in-flight limit, budget and coalescing moved too, not just the cooldown.** Leaving them
  per isolate would have kept documented limits that are only true per isolate.
- **A sliding 60-second budget, persisted.** A fixed window allows twice the budget across the turn
  of a minute. The start times are also what spacing reads after a restart.
- **`UPSTREAM_LIMITER` removed.** The global budget is stricter than a per-location one, and a limiter
  called before admission would charge requests that are then refused.
- **`UPSTREAM_REACTIVATION_ID` is single use, remembered per value.** Comparing with the previous
  value is not enough: a rollback can restore an older value, and one set before a halt would
  authorize that halt in advance. It is deliberately not in `wrangler.toml`.
- **A coordinator failure reaches clients as `busy`, with `Retry-After: 60`.** No new error code: the
  web and desktop clients already pause on `busy`, so nothing shipped to users has to change.
- **`exports` in `wrangler.toml`, not `migrations`.** Cloudflare's current form for new Durable Object
  classes; Wrangler 4.157.0 validates it. The two are mutually exclusive, so this cannot be switched
  later. Either form blocks `wrangler rollback` across the class's creation; the rollback path is the
  attestation switch (gateway README, "Roll back").
- **Real-runtime tests use the Miniflare that Wrangler 4.157.0 bundles,** so they run the same workerd
  as the deployment. Its options are the newer `{ config, dev }` shape of a 5.x beta and may change
  when `WRANGLER_VERSION` is raised. Their temporary state is in the system temporary folder because
  workerd cannot open a SQLite path over 260 characters on Windows.
