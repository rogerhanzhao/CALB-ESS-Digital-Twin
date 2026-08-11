import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { datasetValidationPolicies } from "../../../../../db/schema";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { id } = await params;
  const approvedAt = new Date().toISOString();
  const updated = await getDb().update(datasetValidationPolicies)
    .set({ status: "approved", approvedAt })
    .where(and(eq(datasetValidationPolicies.id, id), eq(datasetValidationPolicies.userId, owner), eq(datasetValidationPolicies.status, "draft")))
    .returning();
  if (!updated.length) return Response.json({ error: "Draft validation policy not found" }, { status: 404 });
  return Response.json({ policy: updated[0] });
}
