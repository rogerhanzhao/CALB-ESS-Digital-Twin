import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { runs, scenarios } from "../../../db/schema";
import {
  deriveDemoView,
  parseCreateRunInput,
  parseIdempotencyKey,
  toRunView,
} from "../../../lib/runs";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function userId(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

function unauthorized() {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}

function parsePaging(url: URL) {
  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const rawOffset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  return { limit, offset };
}

/**
 * List the caller's runs.
 *
 * Strictly read-only. Demonstrator progress is derived in the response and never
 * written back — see `docs/design-review.md` P0-2 for why the V0.1 read path could
 * not stay as it was.
 */
export async function GET(request: Request) {
  const owner = userId(request);
  if (!owner) return unauthorized();

  const { limit, offset } = parsePaging(new URL(request.url));
  const db = getDb();
  const rows = await db
    .select({ run: runs, scenario: scenarios })
    .from(runs)
    .innerJoin(scenarios, eq(runs.scenarioId, scenarios.id))
    .where(eq(runs.userId, owner))
    .orderBy(desc(runs.createdAt))
    .limit(limit)
    .offset(offset);

  const simulations = rows.map(({ run, scenario }) => deriveDemoView(toRunView(run, scenario)));
  return Response.json({ simulations, limit, offset });
}

/** Create a scenario and queue one run against it. */
export async function POST(request: Request) {
  const owner = userId(request);
  if (!owner) return unauthorized();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = parseCreateRunInput(payload);
  if (!parsed.ok) {
    return Response.json({ error: "invalid request", details: parsed.errors }, { status: 400 });
  }
  const input = parsed.value;

  const key = parseIdempotencyKey(request);
  if (!key.ok) {
    return Response.json({ error: "invalid request", details: key.errors }, { status: 400 });
  }
  const idempotencyKey = key.value;
  const db = getDb();

  // A retried submission carrying the same key must not create a second run.
  if (idempotencyKey) {
    const existing = await db
      .select({ run: runs, scenario: scenarios })
      .from(runs)
      .innerJoin(scenarios, eq(runs.scenarioId, scenarios.id))
      .where(and(eq(runs.userId, owner), eq(runs.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing.length > 0) {
      const view = toRunView(existing[0].run, existing[0].scenario);
      return Response.json({ simulation: deriveDemoView(view) }, { status: 200 });
    }
  }

  const now = new Date().toISOString();
  const scenario = {
    id: crypto.randomUUID(),
    userId: owner,
    name: input.name,
    chemistry: input.chemistry,
    cellParamSetVersion: null,
    // This endpoint creates ad-hoc studies. Instantiating a versioned standard scenario is
    // a separate flow, so the link is genuinely absent here rather than merely unset.
    standardScenarioId: null,
    horizonYears: input.horizonYears,
    cyclesPerDay: input.cyclesPerDay,
    depthOfDischarge: input.depthOfDischarge,
    ambientTemperatureC: input.ambientTemperatureC,
    initialSoc: input.initialSoc,
    eolFraction: input.eolFraction,
    createdAt: now,
  };
  const run = {
    id: crypto.randomUUID(),
    scenarioId: scenario.id,
    userId: owner,
    idempotencyKey,
    // No compute worker is connected yet, so this run can only be served by the
    // demonstrator. The marker is permanent and is surfaced by the API and the UI.
    engine: "demo",
    modelVersion: null,
    codeRevision: null,
    status: "queued",
    progress: 0,
    endSoh: null,
    attempt: 0,
    leaseExpiresAt: null,
    heartbeatAt: null,
    checkpointUri: null,
    error: null,
    withinValidityEnvelope: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.batch([
    db.insert(scenarios).values(scenario),
    db.insert(runs).values(run),
  ]);

  return Response.json({ simulation: toRunView(run, scenario) }, { status: 201 });
}
