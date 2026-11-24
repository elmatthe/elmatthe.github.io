// Test-only entry point for gateway-runtime.test.cjs; never deployed. It is the real Worker
// and the real coordinator in the real runtime, with two additions a test cannot do from
// outside: the coordinator's clock can be moved forward (a wait of an hour should not take an
// hour), and its SQL can be reached, to inspect it and to break it.
import worker, { UpstreamCoordinator as Real } from "../../../_services/market-data-gateway/src/worker.js";
import { sqlStorage } from "../../../_services/market-data-gateway/src/coordinator.js";

export class UpstreamCoordinator extends Real {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_clock (id INTEGER PRIMARY KEY, offset_ms INTEGER NOT NULL)");
    const [row] = ctx.storage.sql.exec("SELECT offset_ms FROM test_clock").toArray();
    this.offset = row?.offset_ms ?? 0;
  }
  clock() { return Date.now() + (this.offset ?? 0); }
  testAdvance(ms) {
    this.offset += ms;
    this.ctx.storage.sql.exec("INSERT INTO test_clock (id, offset_ms) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET offset_ms = excluded.offset_ms", this.offset);
    return this.offset;
  }
  testNow() { return this.clock(); }
  testSql(statement) { return this.ctx.storage.sql.exec(statement).toArray(); }
  testRowsWritten() {
    const storage = sqlStorage(this.ctx.storage);
    const { state } = storage.read();
    return storage.write(state ?? { cooldownUntil: 0, cooldownCode: null, haltCode: null, failures: 0, starts: [] });
  }
  testReset() { this.ctx.abort("test reset"); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/__test/")) return worker.fetch(request, env, ctx);
    const stub = env.UPSTREAM_COORDINATOR.getByName("yahoo-chart");
    switch (url.pathname) {
      case "/__test/advance": return Response.json(await stub.testAdvance(Number(url.searchParams.get("ms"))));
      case "/__test/now": return Response.json(await stub.testNow());
      case "/__test/sql": return Response.json(await stub.testSql(url.searchParams.get("q")));
      case "/__test/rows-written": return Response.json(await stub.testRowsWritten());
      case "/__test/reset":
        try { await stub.testReset(); } catch (_) { /* the object has gone, which is the point */ }
        return Response.json(true);
      default: return new Response("unknown test path", { status: 404 });
    }
  },
};
