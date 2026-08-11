import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { standardScenarios } from "../../../../../db/schema";

type Context = { params: Promise<{ id: string }> };

function ownerOf(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

export async function POST(request: Request, { params }: Context) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const [scenario] = await db
    .select()
    .from(standardScenarios)
    .where(and(eq(standardScenarios.id, id), eq(standardScenarios.userId, owner)))
    .limit(1);
  if (!scenario) return Response.json({ error: "Standard scenario not found" }, { status: 404 });
  if (scenario.status === "released") return Response.json({ standardScenario: scenario });
  if (scenario.status !== "draft") {
    return Response.json({ error: "Only a draft scenario can be released" }, { status: 409 });
  }

  const requiredExecutionFields = [
    scenario.codeRevision,
    scenario.cellTemperatureC,
    scenario.operatingAvailabilityFraction,
    scenario.maxChargeCRate,
    scenario.maxDischargeCRate,
  ];
  if (requiredExecutionFields.some((value) => value === null)) {
    return Response.json(
      { error: "Legacy scenario is incomplete and cannot be released; register a new version" },
      { status: 409 },
    );
  }

  const updated = await db
    .update(standardScenarios)
    .set({ status: "released" })
    .where(
      and(
        eq(standardScenarios.id, id),
        eq(standardScenarios.userId, owner),
        eq(standardScenarios.status, "draft"),
      ),
    );
  if (updated.meta.changes !== 1) {
    return Response.json({ error: "Scenario status changed concurrently" }, { status: 409 });
  }
  return Response.json({ standardScenario: { ...scenario, status: "released" } });
}
