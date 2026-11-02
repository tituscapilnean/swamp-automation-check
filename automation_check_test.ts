/**
 * Unit tests for automation_check.ts orchestration. A stub CEL environment
 * maps each expression to a JS function, so these tests cover the check
 * logic (missing data, freshness, severities, expression errors) without
 * depending on swamp's CEL runtime.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1.0.13";
import { type CelEnv, evaluateTarget, getPath, hoursSince, summarize } from "./automation_check.ts";

const now = new Date("2026-11-02T15:00:00Z");
// deno-lint-ignore no-explicit-any
type Vars = Record<string, any>;
const stub = (fns: Record<string, (v: Vars) => unknown>): CelEnv => ({
  parse: (expr) => (vars) => {
    const f = fns[expr];
    if (!f) throw new Error(`unknown expr ${expr}`);
    return f(vars);
  },
});
const target = {
  behavior: "scan",
  dataName: "current",
  timestampField: "scannedAt",
  maxAgeHours: 6,
  checks: [
    { name: "enough", expr: "E", severity: "error" as const },
    { name: "few-errors", expr: "W", severity: "warn" as const, message: "boards failed" },
  ],
};
const env = stub({
  E: (v) => v.current.companies >= 40,
  W: (v) => v.current.errors === 0,
});

Deno.test("getPath and hoursSince", () => {
  assertEquals(getPath({ a: { b: 3 } }, "a.b"), 3);
  assertEquals(getPath({ a: 1 }, "a.b"), undefined);
  assertEquals(hoursSince("2026-11-02T12:00:00Z", now), 3);
  assertEquals(hoursSince("nope", now), null);
});

Deno.test("missing data is an error", () => {
  const r = evaluateTarget(target, null, null, env, now);
  assertEquals([r.passed, r.results[0].name], [false, "data-exists"]);
});

Deno.test("all checks pass", () => {
  const r = evaluateTarget(
    target,
    { version: 3, attributes: { scannedAt: "2026-11-02T14:00:00Z", companies: 56, errors: 0 } },
    { companies: 56 },
    env,
    now,
  );
  assertEquals(r.passed, true);
  assertEquals(summarize([r], now).errorCount, 0);
});

Deno.test("warn failures do not fail the target; error failures do", () => {
  const warnOnly = evaluateTarget(
    target,
    { version: 1, attributes: { scannedAt: "2026-11-02T14:00:00Z", companies: 56, errors: 2 } },
    null,
    env,
    now,
  );
  assertEquals([warnOnly.passed, summarize([warnOnly], now).warnCount], [true, 1]);
  const stale = evaluateTarget(
    target,
    { version: 1, attributes: { scannedAt: "2026-11-01T00:00:00Z", companies: 10, errors: 0 } },
    null,
    env,
    now,
  );
  const s = summarize([stale], now);
  assertEquals([stale.passed, s.passed, s.errorCount], [false, false, 2]);
});

Deno.test("a check whose expression throws fails with the error recorded", () => {
  const r = evaluateTarget(
    { ...target, maxAgeHours: undefined, checks: [{ name: "bad", expr: "X", severity: "error" }] },
    { version: 1, attributes: {} },
    null,
    env,
    now,
  );
  assertEquals([r.passed, r.results[0].error], [false, "unknown expr X"]);
});

Deno.test("previous is exposed with hasPrevious", () => {
  const seen: Vars[] = [];
  const spy: CelEnv = { parse: () => (v) => (seen.push(v), true) };
  evaluateTarget({ ...target, checks: [{ name: "p", expr: "P", severity: "warn" }] }, {
    version: 2,
    attributes: { scannedAt: "2026-11-02T14:00:00Z" },
  }, null, spy, now);
  assertEquals([seen[0].hasPrevious, seen[0].previous], [false, {}]);
});
