import type { JobPayload } from "@contracts/generated/contracts";
import type { runs, scenarios } from "../db/schema";

/**
 * Request validation and demonstrator-view derivation for simulation runs.
 *
 * Two rules from `docs/design-review.md` are enforced here rather than in the
 * route handlers, so that they hold for every caller:
 *
 *  - Invalid input is rejected with an explicit error. It is never silently
 *    clamped, and it can never reach the database as `NaN` (P1-3).
 *  - Demonstrator progress is *derived*, never persisted. `deriveDemoView` is a
 *    pure function of the stored row and the current clock (P0-2).
 */

/** Cell chemistries with an approved parameter set. Extend as `cell_database` publishes more. */
export const APPROVED_CHEMISTRIES = ["LFP"] as const;
export type Chemistry = (typeof APPROVED_CHEMISTRIES)[number];

export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

/**
 * The engine vocabulary, taken from the contract instead of restated here.
 *
 * `contracts/models.py` is the single source of truth; `contracts/generated/contracts.ts`
 * is generated from it and CI fails if the two drift (`test_generated_contracts_are_current`).
 * Importing the union means the control plane cannot quietly disagree with the compute
 * plane about what an engine is, which is exactly what happened while this was `string`.
 */
export type RunEngine = JobPayload["engine"];

/**
 * Exhaustive membership map, not an array.
 *
 * A plain `["demo", ...]` literal would silently go stale when the contract gains an
 * engine. Because this is typed `Record<RunEngine, true>`, adding a member to the
 * contract makes this object fail to typecheck until it is updated — the drift becomes
 * a build error rather than a runtime surprise.
 */
const RUN_ENGINES: Record<RunEngine, true> = {
  demo: true,
  stub: true,
  "pybamm-spme": true,
  "semi-empirical": true,
};

export function isRunEngine(value: string): value is RunEngine {
  return Object.hasOwn(RUN_ENGINES, value);
}

export type ScenarioRow = typeof scenarios.$inferSelect;
export type RunRow = typeof runs.$inferSelect;

export type RunView = {
  id: string;
  scenarioId: string;
  name: string;
  chemistry: string;
  cellParamSetVersion: string | null;
  horizonYears: number;
  cyclesPerDay: number;
  depthOfDischarge: number;
  ambientTemperatureC: number;
  initialSoc: number;
  eolFraction: number;
  /**
   * `"unrecognized"` when the stored value is outside the contract vocabulary.
   *
   * The column is free-form `text`, so the database cannot guarantee the union. Rather
   * than assert a type the storage does not enforce, an unknown value is surfaced under
   * its own name: it is visibly not a demonstrator row and visibly not a real engine,
   * which is the honest reading of a row nothing in this repository should have written.
   */
  engine: RunEngine | "unrecognized";
  modelVersion: string | null;
  codeRevision: string | null;
  status: string;
  progress: number;
  endSoh: number | null;
  withinValidityEnvelope: boolean | null;
  createdAt: string;
  updatedAt: string;
  /** True when the numbers above came from the demonstrator, not from a compute worker. */
  demo: boolean;
};

export type CreateRunInput = {
  name: string;
  chemistry: Chemistry;
  horizonYears: number;
  cyclesPerDay: number;
  depthOfDischarge: number;
  ambientTemperatureC: number;
  initialSoc: number;
  eolFraction: number;
};

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type NumericField = {
  key: keyof CreateRunInput;
  min: number;
  max: number;
  fallback: number;
  integer?: boolean;
};

const NUMERIC_FIELDS: NumericField[] = [
  { key: "horizonYears", min: 1, max: 25, fallback: 20, integer: true },
  { key: "cyclesPerDay", min: 0.25, max: 3, fallback: 1 },
  { key: "depthOfDischarge", min: 0.1, max: 1, fallback: 0.9 },
  { key: "ambientTemperatureC", min: -20, max: 60, fallback: 25 },
  { key: "initialSoc", min: 0, max: 1, fallback: 0.5 },
  { key: "eolFraction", min: 0.5, max: 0.95, fallback: 0.8 },
];

const MAX_NAME_LENGTH = 120;

/**
 * Only an omitted field falls back to a default.
 *
 * An explicit `null`, an empty string, or a wrong type is a caller error and is
 * rejected. Treating them as "absent" would silently substitute a default and run a
 * different simulation than the caller described — the same class of failure as the
 * silent clamping this validator replaced.
 */
function isOmitted(value: unknown): boolean {
  return value === undefined;
}

export function parseCreateRunInput(payload: unknown): Validated<CreateRunInput> {
  const errors: string[] = [];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }
  const body = payload as Record<string, unknown>;

  const rawName = body.name;
  let name = "";
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    errors.push("name is required and must be a non-empty string");
  } else if (rawName.trim().length > MAX_NAME_LENGTH) {
    errors.push(`name must be at most ${MAX_NAME_LENGTH} characters`);
  } else {
    name = rawName.trim();
  }

  let chemistry: Chemistry = "LFP";
  if (!isOmitted(body.chemistry)) {
    if (!APPROVED_CHEMISTRIES.includes(body.chemistry as Chemistry)) {
      errors.push(
        `chemistry must be one of: ${APPROVED_CHEMISTRIES.join(", ")} (omit the field to use LFP)`,
      );
    } else {
      chemistry = body.chemistry as Chemistry;
    }
  }

  const numbers: Partial<Record<keyof CreateRunInput, number>> = {};
  for (const field of NUMERIC_FIELDS) {
    const raw = body[field.key];
    if (isOmitted(raw)) {
      numbers[field.key] = field.fallback;
      continue;
    }
    // Reject rather than clamp: a value outside the supported range is a caller
    // error, and clamping it would silently change what was simulated.
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      errors.push(
        `${field.key} must be a finite number (omit the field to use ${field.fallback})`,
      );
      continue;
    }
    if (field.integer && !Number.isInteger(raw)) {
      errors.push(`${field.key} must be an integer`);
      continue;
    }
    if (raw < field.min || raw > field.max) {
      errors.push(`${field.key} must be between ${field.min} and ${field.max}`);
      continue;
    }
    numbers[field.key] = raw;
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name,
      chemistry,
      horizonYears: numbers.horizonYears!,
      cyclesPerDay: numbers.cyclesPerDay!,
      depthOfDischarge: numbers.depthOfDischarge!,
      ambientTemperatureC: numbers.ambientTemperatureC!,
      initialSoc: numbers.initialSoc!,
      eolFraction: numbers.eolFraction!,
    },
  };
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Read the idempotency key, distinguishing an absent header from an invalid one.
 *
 * A caller that sent a key is relying on retry safety. Quietly discarding a
 * malformed key would drop that guarantee exactly when it matters — on the retry —
 * and create a duplicate run, so an invalid header is an error rather than an absent
 * one.
 */
export function parseIdempotencyKey(request: Request): Validated<string | null> {
  const raw = request.headers.get("idempotency-key");
  if (raw === null) return { ok: true, value: null };

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, errors: ["Idempotency-Key must not be blank; omit the header instead"] };
  }
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return {
      ok: false,
      errors: [`Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`],
    };
  }
  return { ok: true, value: trimmed };
}

/** Wall-clock milliseconds the demonstrator takes to advance one percent. */
const DEMO_MS_PER_PERCENT = 1800;

/**
 * Illustrative end-of-life value for demonstrator rows.
 *
 * This is a placeholder shape carried over from V0.1, not a model. It exists so the
 * interface has something to lay out before a compute worker is connected, and it is
 * only ever attached to rows carrying `engine = 'demo'`.
 */
function demoEndSoh(horizonYears: number, cyclesPerDay: number): number {
  return Number((84.6 - horizonYears * 0.17 - cyclesPerDay * 0.4).toFixed(1));
}

export function toRunView(run: RunRow, scenario: ScenarioRow): RunView {
  return {
    id: run.id,
    scenarioId: scenario.id,
    name: scenario.name,
    chemistry: scenario.chemistry,
    cellParamSetVersion: scenario.cellParamSetVersion,
    horizonYears: scenario.horizonYears,
    cyclesPerDay: scenario.cyclesPerDay,
    depthOfDischarge: scenario.depthOfDischarge,
    ambientTemperatureC: scenario.ambientTemperatureC,
    initialSoc: scenario.initialSoc,
    eolFraction: scenario.eolFraction,
    engine: isRunEngine(run.engine) ? run.engine : "unrecognized",
    modelVersion: run.modelVersion,
    codeRevision: run.codeRevision,
    status: run.status,
    progress: run.progress,
    endSoh: run.endSoh,
    withinValidityEnvelope:
      run.withinValidityEnvelope === null ? null : run.withinValidityEnvelope === 1,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    demo: run.engine === "demo",
  };
}

/**
 * Advance a demonstrator row for display only.
 *
 * The caller must not persist the result. Rows produced by a real compute worker
 * (`engine !== 'demo'`) are returned untouched — their progress belongs to the worker
 * holding the lease, and overwriting it here is exactly the race the V0.1 read path
 * introduced.
 */
/**
 * Whether a run may still be cancelled, and the status to report when it may not.
 *
 * Judged on the derived view rather than the stored row. A demonstrator run reads as
 * completed once enough wall-clock time has passed, while its stored status is still
 * `queued`, because demonstrator progress is deliberately never persisted. Judging on
 * the stored row would let a caller cancel a run the interface has already shown them
 * as finished.
 */
export function cancellability(
  view: RunView,
  now: number = Date.now(),
): { cancellable: true } | { cancellable: false; status: string } {
  const derived = deriveDemoView(view, now);
  return (TERMINAL_STATUSES as readonly string[]).includes(derived.status)
    ? { cancellable: false, status: derived.status }
    : { cancellable: true };
}

export function deriveDemoView(view: RunView, now: number = Date.now()): RunView {
  if (!view.demo) return view;
  if ((TERMINAL_STATUSES as readonly string[]).includes(view.status)) return view;

  const elapsed = now - Date.parse(view.createdAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return view;

  const progress = Math.min(100, Math.max(view.progress, Math.floor(elapsed / DEMO_MS_PER_PERCENT)));
  const status = progress >= 100 ? "completed" : progress > 4 ? "running" : "queued";

  return {
    ...view,
    progress,
    status,
    endSoh: progress >= 100 ? demoEndSoh(view.horizonYears, view.cyclesPerDay) : null,
  };
}
