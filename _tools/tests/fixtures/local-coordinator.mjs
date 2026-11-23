// The real coordinator logic (_services/market-data-gateway/src/coordinator.js), running in
// this process behind the same calls the Worker makes on its Durable Object binding, for
// tests with a controlled clock. The real SQLite storage and runtime are covered by
// ../worker-runtime/. Never contacts anything but the `fetchImpl` it is given.
import { UpstreamCoordinatorCore } from "../../../_services/market-data-gateway/src/coordinator.js";
import { createGateway } from "../../../_services/market-data-gateway/src/gateway.js";

// The same contract as sqlStorage, serialized so nothing survives by reference, with the
// failures a test can ask for. Like SQLite in a Durable Object, a statement that returns is
// not yet committed. `commits` chooses what `confirm` (storage.sync()) does:
//   "auto"    every write is committed as it is made, and confirmed at once;
//   "manual"  writes since the last commit wait, visible to reads as in one SQLite connection,
//             until `commit()` confirms them or `rollback()` restores the last commit and
//             refuses their confirmations (a deferred constraint failing at commit);
//   "never"   a confirmation that never settles.
export function memoryStorage() {
  let row = null;
  let seen = new Set();
  let batch = null; // manual mode: { row, seen, waiters } as of the last commit
  const open = () => { if (storage.commits === "manual" && !batch) batch = { row, seen: new Set(seen), waiters: [] }; };
  const storage = {
    failReads: false,
    failWrites: false,
    failReactivation: false,
    commits: "auto",
    writes: 0,
    confirms: 0,
    read() {
      if (storage.failReads) throw new Error("storage read failed");
      return { state: row === null ? null : JSON.parse(row), seen: [...seen] };
    },
    write(state) {
      if (storage.failWrites) throw new Error("database or disk is full: SQLITE_FULL");
      open();
      storage.writes += 1;
      row = JSON.stringify(state);
      return 1;
    },
    reactivate(state, id) {
      if (storage.failWrites || storage.failReactivation) throw new Error("database or disk is full: SQLITE_FULL");
      open();
      seen.add(id);
      row = JSON.stringify(state);
    },
    confirm() {
      storage.confirms += 1;
      if (storage.commits === "never") return new Promise(() => {});
      if (!batch) return Promise.resolve();
      return new Promise((resolve, reject) => batch.waiters.push({ resolve, reject }));
    },
    // Settles the waiting batch; `reverse` delivers the acknowledgements in the opposite order.
    commit({ reverse = false } = {}) {
      const waiters = batch?.waiters ?? [];
      batch = null;
      (reverse ? [...waiters].reverse() : waiters).forEach(w => w.resolve());
    },
    rollback() {
      if (!batch) return;
      ({ row, seen } = batch);
      const { waiters } = batch;
      batch = null;
      waiters.forEach(w => w.reject(new Error("FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_FOREIGNKEY")));
    },
    peek: () => (row === null ? null : JSON.parse(row)),
    // What a fresh instance would read if the waiting batch were lost.
    peekCommitted() {
      const committed = batch ? batch.row : row;
      return committed === null ? null : JSON.parse(committed);
    },
    corrupt: state => { row = JSON.stringify(state); },
  };
  return storage;
}

// A stand-in for env.UPSTREAM_COORDINATOR. Answers cross a serialization boundary as they do
// over RPC. `restart()` is a new instance of the object on the same storage, as after an
// eviction or a deployment: everything in memory is gone.
export function localCoordinator({ fetchImpl, now, sleep, log = () => {}, limits = {}, storage = memoryStorage(), env = {} }) {
  const build = () => new UpstreamCoordinatorCore({ storage, env, fetchImpl, now, sleep, log, limits });
  let core = build();
  const names = [];
  const arrivals = []; // symbols, in the order they reached the coordinator
  const stub = {
    fetchChart: async request => {
      arrivals.push(request.symbol);
      return structuredClone(await core.fetchChart(structuredClone(request)));
    },
    cancel: async client => { core.cancel(client); },
    status: async () => structuredClone(core.status()),
  };
  return {
    getByName(name) {
      names.push(name);
      return stub;
    },
    restart() { core = build(); },
    names,
    arrivals,
    storage,
    env,
  };
}

// The real gateway with this coordinator bound, for tests about the clients and the contract.
export function testGateway({ fetchImpl, now, sleep, log = () => {}, cache = null, limits = {} }) {
  const coordinator = localCoordinator({ fetchImpl, now, sleep, log, limits });
  const gateway = createGateway({ ...(now ? { now } : {}), log, cache, limits });
  return { coordinator, handle: (request, env = {}, ctx) => gateway.handle(request, { UPSTREAM_COORDINATOR: coordinator, ...env }, ctx) };
}
