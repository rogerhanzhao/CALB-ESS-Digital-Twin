import { and, asc, eq, max } from "drizzle-orm";
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

  const db = getDb();
  // Version is assigned, not accepted. A submitted version only has to be unique to pass an
  // index, which allowed publishing V9 and then V1 for the same family -- a history that
  // reads as progression while being nothing of the sort.
  const [highest] = await db
    .select({ version: max(standardScenarios.version) })
    .from(standardScenarios)
    .where(and(eq(standardScenarios.userId, owner), eq(standardScenarios.code, parsed.value.code)));
  const version = (highest?.version ?? 0) + 1;

  const scenario = {
    id: crypto.randomUUID(),
    userId: owner,
    ...parsed.value,
    version,
    status: "draft" as const,
    createdAt: new Date().toISOString(),
  };
  // D1 has no interactive transactions, so the read above cannot be atomic with this write.
  // The unique index is what actually holds the line: two concurrent publishes compute the
  // same next version and one of them loses here rather than quietly sharing a version.
  try {
    await db.insert(standardScenarios).values(scenario);
  } catch {
    return Response.json(
      { error: "A concurrent publish claimed this version. Retry to take the next one." },
      { status: 409 },
    );
  }
  return Response.json({ standardScenario: scenario }, { status: 201 });
}
