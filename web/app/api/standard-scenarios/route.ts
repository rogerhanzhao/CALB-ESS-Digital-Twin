import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { standardScenarios } from "../../../db/schema";
import { parseStandardScenarioInput } from "../../../lib/scenarios";

function ownerOf(request: Request) { return request.headers.get("oai-authenticated-user-id"); }

export async function GET(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const scenarios = await getDb()
    .select()
    .from(standardScenarios)
    .where(eq(standardScenarios.userId, owner))
    .orderBy(asc(standardScenarios.code), asc(standardScenarios.version));
  return Response.json({ standardScenarios: scenarios });
}

export async function POST(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  let payload: unknown;
  try { payload = await request.json(); } catch { return Response.json({ error: "request body must be valid JSON" }, { status: 400 }); }
  const parsed = parseStandardScenarioInput(payload);
  if (!parsed.ok) return Response.json({ error: "invalid request", details: parsed.errors }, { status: 400 });

  const scenario = {
    id: crypto.randomUUID(),
    userId: owner,
    ...parsed.value,
    status: "draft" as const,
    createdAt: new Date().toISOString(),
  };
  // The unique index is the authority, not a prior SELECT: a check-then-insert would still
  // race, and redefining an existing version is exactly what must never succeed quietly.
  try {
    await getDb().insert(standardScenarios).values(scenario);
  } catch {
    return Response.json(
      { error: "This scenario code and version already exists. Publish a new version instead of redefining one." },
      { status: 409 },
    );
  }
  return Response.json({ standardScenario: scenario }, { status: 201 });
}
