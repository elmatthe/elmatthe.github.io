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

## 2026-11-05: unresolved upstream outcomes remain durable (PR 46 R4)

The R3 independent review reproduced a lost refusal: admission persisted, the SQLite outcome
write failed, then a restarted coordinator admitted another symbol. Process memory was not
sufficient, and a successful response or non-stopping refusal sometimes skipped writing.

- Admission now atomically writes its budget start and a unique unresolved marker in the
  existing state row before fetch, preserving output gates and the synchronous decision.
- Every known outcome atomically commits protective state and removes only its own marker,
  including unchanged HTTP 200/404 outcomes. SQL failure returns unverified busy without
  populating cache or incrementing the provider failure counter.
- A live instance can retry its actual observed merged outcome. After restart, outcomes
  are lost: persisted markers quarantine access indefinitely, even after storage recovers.
- Admitted cancellation, timeout and unknown abort retain uncertainty; queued cancellation
  still costs no budget. Expired leases cannot prove provider work ended. A late known
  refusal still records the provider direction. Two healthy active requests remain usable.
- Only a fresh owner identifier can clear lost-outcome quarantine, transactionally with its
  consumed history. Existing cooldown deadlines remain. Operators must reconcile and drain
  possibly running remote work; automatic expiry or state deletion is not recovery.
- Schema migration retains the same class, namespace, row and ID history. Nonempty R3 starts
  migrate conservatively to uncertainty. Malformed markers fail closed. R3 serving rollback
  is unsafe because it ignores markers; retain an R4-compatible source-off fallback instead.
- At most two markers share the existing row. Normal cost remains two row writes per start,
  approximately 57,600/day at the admission budget; migration, retries and owner IDs add cost.

Scope is H1 only. M1 source activation inside the coordinator, M2 health protection,
M3 production source-off/drain and Q1 unexpected-response policy remain separate work.
Production 1.1.0 and the separate CPI Excel preservation issue are unchanged.

## 2026-11-23: no HTTP status means no known outcome (PR 46 R5)

The independent R4 review (Codex, FAIL, finding H2 High) reproduced in real workerd that a
connection closed before response headers was finalized as ordinary unavailability: the
marker was removed and, after a restart, another isolate reached the source. The source may
have received the request and refused it; the refusal was lost with the connection.

- Only an observed HTTP status finalizes a marker. A `fetch()` rejection with no response
  retains the marker, quarantines the source and answers `busy`, like a timeout.
- The breaker counter still counts the failure; the counter and the marker are separate.
- A body lost after a status was observed finalizes that status (200 or a refusal).
  *Superseded for HTTP 200 by the R6 entry below: a status alone never finalizes a 200.*
- Cost: any transport failure now needs the owner's reconciliation and a fresh identifier,
  as a timeout already did. Workers cannot prove a failure happened before dispatch, so no
  narrower exception was attempted.

Not changed here, left for an owner decision: the review's M4 (a provisioned identifier
the coordinator never observed is not bound to the incident it later clears) and L3
(`cooldown_started` is logged before its write succeeds).

## 2026-11-23: an HTTP 200 status alone is not a completed outcome (PR 46 R6)

The independent R5 review (Codex, QUALIFIED, finding M5 Medium) showed that an observed
HTTP 200 followed by the body deadline was quarantined, while the R5 docs said a status
always finalizes. R5 also finalized a 200 whose body was interrupted without an abort.

- Owner decision: receiving HTTP 200 headers does not establish that the upstream work
  completed. A 200 whose body does not finish, whether interrupted, timed out or cancelled,
  keeps its marker and quarantines the source, exactly as a lost status does. Releasing the
  place early could defeat the protection against unresolved upstream work; availability is
  not bought by assuming it ended.
- Consequence: a genuinely incomplete response needs owner reconciliation and an explicit
  reactivation. Cached answers are still served meanwhile.
- Unchanged: a refusal status is committed when it arrives, before its body is touched; a
  complete 200 finalizes; a 200 over the 2 MiB cap is a complete answer refused by the
  gateway's own limit and finalizes. The persistence design is unchanged.
- L3: `cooldown_started` is logged only after the stop's write succeeds (derived from the
  last state confirmed on disk); a failed write logs `cooldown_not_persisted`. Stop
  calculation, precedence and storage order are unchanged.

Still open for the owner: M4 (reactivation not bound to a specific incident; an
incident-bound design is proposed privately for the next phase), M1, M2, M3 and Q1.

## 2026-11-23: a logged stop is a committed stop (PR 46 R7)

The independent R6 review (Codex, QUALIFIED) reproduced in real workerd that a SQLite
statement can return and its implicit commit still fail (a deferred foreign key): R6 had
already logged `cooldown_started` for a stop that was rolled back (L3). It also found that
an oversize body waited for its stream cancellation (L5) and that the calendar test derived
its too-old threshold from the constant it should pin (L6).

- `cooldown_started` and `source_reactivated` are logged only when `storage.sync()` confirms
  the commit (Cloudflare: it resolves only once every earlier write is on disk). Writes are
  tracked in order and confirmed in order, so a stop is logged once, in recording order,
  whatever order acknowledgements arrive in. Nothing is awaited: the admission decision, its
  write and `fetch()` stay one synchronous step, and the output gate still holds the request
  until the same commit. Considered and rejected: awaiting `sync()` in the outcome path
  before answering. It would delay every answer and protect nothing more, since the runtime
  already withholds the answer until the commit, and a reset object never resumes the await.
- A refused confirmation ends that instance: it admits nothing and writes nothing more
  until the runtime replaces it, because its memory may hold effects disk does not (a
  rolled-back reactivation would otherwise be rewritten without its consumed identifier).
  This mirrors the platform, which resets an object whose commit fails; in real workerd the
  reset happens before any handler logs, so a commit failure shows as `busy` and
  `unverified` health, never as a started stop. Statement failures keep the R6 behaviour:
  `cooldown_not_persisted`, rewrite on recovery, `cooldown_started` once that commit is
  confirmed.
- An oversize HTTP 200 cancels the rest of its body without waiting. The 2 MiB cap and the
  finalization policy are unchanged.
- The calendar test pins one session (stale) and four (too old) as literals.

Unchanged and still open: M4, M1, M2, M3, Q1, L1.

## 2026-11-23: an approval clears one incident, the one it names (PR 46 M4)

M4 (R5-R7 reviews): a never-seen `UPSTREAM_REACTIVATION_ID` cleared whatever halt or
unresolved outcome existed when the coordinator first observed it, so a value provisioned
earlier could clear an incident the owner never reviewed. Single use alone did not bind it.

- Each incident (a halt, or an unresolved outcome; never a cooldown) gets a generation and a
  128-bit nonce, stored in the singleton state row in the same write as the outcome that opens
  or changes it. Any change of scope, a further halt-level direction, a restart finding
  requests in flight, or a row written by other code (a copy of the six pre-M4 columns,
  `m4_row`, no longer matches) gives a new generation and nonce. A value written before the
  incident cannot contain its nonce. Considered and rejected: a separate incidents table with
  a unique open-incident index (more parts for the same guarantee), and a digest of the
  scope's random marker IDs (those exist from admission, before the request is an incident).
- `UPSTREAM_INCIDENT_APPROVAL = g<generation>-<nonce>` is evaluated only at the object's
  start (a secret change is a deployment, which restarts it), never by a request or a health
  read. It is accepted only for the current generation and nonce, if unused, **with the source
  switched off in that deployment** (owner decision D2), and once the incident's newest request
  is 60 s old (an instance that shut down lets a request that touches no storage finish).
  Approval, its record and the clearing are one transaction; cooldowns are never shortened.
  `UPSTREAM_REACTIVATION_ID` is no longer read (D5).
- Owner diagnostics use Cloudflare Data Studio with the documented `SELECT` queries (owner
  decision D1): no new endpoint or token. A Data Studio query starts the object, so it also
  applies an approval while the source is off; this is the only way to start it then.
- Health (`status()`) no longer writes (D4): it does not rewrite a held outcome or reclassify
  expired leases; the data path and the object's start do. Considered and accepted: health
  can stay `unverified` until the next data request after a recovered write.
- Not done (D3 and scope): no new cooldown or provider-wait enforcement on approval; M1, M2,
  M3, Q1, L1 unchanged; L3a accepted as documented.
