/**
 * Health checks for live automations. Reads the latest (and previous) version
 * of other behaviors' data, evaluates CEL checks against it, records the
 * results, and fails the run when an error-severity check fails, so a
 * scheduled workflow turns red instead of quietly producing bad output.
 *
 * CEL variables available to each check:
 * - `current`: the target data's attributes (latest version)
 * - `previous`: the version before it, or `{}` when there is none
 * - `hasPrevious`: whether `previous` exists
 * - `ageHours`: hours since `timestampField` in `current` (-1 when unknown)
 *
 * @module
 */
import { z } from "npm:zod@4";

const CheckSchema = z.object({
  name: z.string().describe("Short check name, e.g. enough-companies"),
  expr: z.string().describe(
    "CEL predicate over current, previous, hasPrevious, ageHours; true = pass",
  ),
  severity: z.enum(["error", "warn"]).default("error"),
  message: z.string().optional().describe("Shown when the check fails"),
});

const TargetSchema = z.object({
  behavior: z.string().describe("Behavior whose data is checked"),
  dataName: z.string().describe("Data item name, e.g. current"),
  timestampField: z.string().optional().describe(
    "Dotted path to an ISO timestamp in the data, used for ageHours",
  ),
  maxAgeHours: z.number().optional().describe(
    "Adds an error check that the data is at most this old",
  ),
  checks: z.array(CheckSchema).default([]),
});

const GlobalArgsSchema = z.object({
  targets: z.array(TargetSchema).min(1),
  failOnError: z.boolean().default(true).describe(
    "Fail the method run when any error-severity check fails",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
/** One automation target: which data to read and which checks to run on it. */
export type Target = z.infer<typeof TargetSchema>;

const ResultSchema = z.object({
  name: z.string(),
  severity: z.enum(["error", "warn"]),
  passed: z.boolean(),
  message: z.string().nullable(),
  error: z.string().nullable(),
});

const TargetResultSchema = z.object({
  behavior: z.string(),
  dataName: z.string(),
  version: z.number().nullable(),
  ageHours: z.number().nullable(),
  passed: z.boolean(),
  results: z.array(ResultSchema),
});

const SummarySchema = z.object({
  checkedAt: z.string(),
  passed: z.boolean(),
  errorCount: z.number(),
  warnCount: z.number(),
  targets: z.array(TargetResultSchema),
});

/** Result of a single check. */
export type CheckResult = z.infer<typeof ResultSchema>;
/** Results for one target. */
export type TargetResult = z.infer<typeof TargetResultSchema>;

/** Minimal shape of the CEL environment the checks need. */
export interface CelEnv {
  parse: (expr: string) => (vars: Record<string, unknown>) => unknown;
}

/** Read a dotted path such as `meta.scannedAt` from an object. */
export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (
      o,
      k,
    ) => (o && typeof o === "object"
      ? (o as Record<string, unknown>)[k]
      : undefined),
    obj,
  );
}

/** Hours between an ISO timestamp and `now`; null when unparseable. */
export function hoursSince(ts: unknown, now: Date): number | null {
  if (typeof ts !== "string") return null;
  const t = Date.parse(ts);
  return Number.isNaN(t)
    ? null
    : Math.round(((now.getTime() - t) / 3_600_000) * 10) / 10;
}

/** Evaluate every check for one target. Pure apart from the CEL env. */
export function evaluateTarget(
  target: Target,
  current: { attributes: Record<string, unknown>; version: number } | null,
  previous: Record<string, unknown> | null,
  env: CelEnv,
  now: Date,
): TargetResult {
  const results: CheckResult[] = [];
  if (!current) {
    results.push({
      name: "data-exists",
      severity: "error",
      passed: false,
      message: `No "${target.dataName}" data found for ${target.behavior}`,
      error: null,
    });
    return {
      behavior: target.behavior,
      dataName: target.dataName,
      version: null,
      ageHours: null,
      passed: false,
      results,
    };
  }
  const ageHours = target.timestampField
    ? hoursSince(getPath(current.attributes, target.timestampField), now)
    : null;
  if (target.maxAgeHours !== undefined) {
    const ok = ageHours !== null && ageHours <= target.maxAgeHours;
    results.push({
      name: "fresh",
      severity: "error",
      passed: ok,
      message: ok
        ? null
        : `Data is ${
          ageHours ?? "of unknown"
        } hours old (max ${target.maxAgeHours})`,
      error: null,
    });
  }
  const vars = {
    current: current.attributes,
    previous: previous ?? {},
    hasPrevious: previous !== null,
    ageHours: ageHours ?? -1,
  };
  for (const c of target.checks) {
    let passed = false;
    let error: string | null = null;
    try {
      passed = env.parse(c.expr)(vars) === true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    results.push({
      name: c.name,
      severity: c.severity,
      passed,
      message: passed ? null : (c.message ?? `Check failed: ${c.expr}`),
      error,
    });
  }
  return {
    behavior: target.behavior,
    dataName: target.dataName,
    version: current.version,
    ageHours,
    passed: results.every((r) => r.passed || r.severity === "warn"),
    results,
  };
}

/** Roll target results up into the stored summary. */
export function summarize(targets: TargetResult[], now: Date) {
  const all = targets.flatMap((t) => t.results);
  const errorCount =
    all.filter((r) => !r.passed && r.severity === "error").length;
  return {
    checkedAt: now.toISOString(),
    passed: errorCount === 0,
    errorCount,
    warnCount: all.filter((r) => !r.passed && r.severity === "warn").length,
    targets,
  };
}

interface DataRecord {
  name: string;
  version: number;
  attributes: Record<string, unknown>;
}

/** Behavior definition for checking live automations' output. */
export const model = {
  type: "@tituscapilnean/automation-check",
  version: "2026.11.01.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    summary: {
      description: "Check results for every target",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 52,
    },
  },
  methods: {
    run: {
      description:
        "Read each target's latest and previous data, evaluate its checks, record the results, and fail on any error-severity failure",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          createCelEnvironment: () => CelEnv;
          readModelData: (name: string, spec?: string) => Promise<DataRecord[]>;
          queryData: (predicate: string) => Promise<unknown[]>;
          logger: {
            info: (m: string, p?: Record<string, unknown>) => void;
            warning: (m: string, p?: Record<string, unknown>) => void;
          };
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const now = new Date();
        const env = context.createCelEnvironment();
        const results: TargetResult[] = [];
        for (const t of context.globalArgs.targets) {
          const recs = (await context.readModelData(t.behavior))
            .filter((r) => r.name === t.dataName);
          const cur = recs.sort((a, b) => b.version - a.version)[0] ?? null;
          let prev: Record<string, unknown> | null = null;
          if (cur && cur.version > 1) {
            const q = await context.queryData(
              `modelName == ${JSON.stringify(t.behavior)} && name == ${
                JSON.stringify(t.dataName)
              } && version == ${cur.version - 1}`,
            ) as DataRecord[];
            prev = q[0]?.attributes ?? null;
          }
          const r = evaluateTarget(t, cur, prev, env, now);
          for (const x of r.results.filter((x) => !x.passed)) {
            context.logger.warning(
              "{behavior} {check} ({severity}): {message}",
              {
                behavior: t.behavior,
                check: x.name,
                severity: x.severity,
                message: x.error ? `${x.message} [${x.error}]` : x.message,
              },
            );
          }
          results.push(r);
        }
        const summary = summarize(results, now);
        context.logger.info(
          "{errors} errors, {warns} warnings across {n} targets",
          {
            errors: summary.errorCount,
            warns: summary.warnCount,
            n: results.length,
          },
        );
        const handle = await context.writeResource(
          "summary",
          "summary",
          summary,
        );
        if (context.globalArgs.failOnError && !summary.passed) {
          throw new Error(
            `${summary.errorCount} automation check(s) failed: ` +
              results.flatMap((t) =>
                t.results.filter((r) => !r.passed && r.severity === "error")
                  .map((r) => `${t.behavior}/${r.name}`)
              ).join(", "),
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
