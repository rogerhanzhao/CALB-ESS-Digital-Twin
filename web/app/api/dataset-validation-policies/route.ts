import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { cellProducts, datasetValidationPolicies } from "../../../db/schema";
import { parseValidationPolicyInput } from "../../../lib/dataset-revisions";

export async function GET(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const policies = await getDb().select().from(datasetValidationPolicies)
    .where(eq(datasetValidationPolicies.userId, owner)).orderBy(desc(datasetValidationPolicies.createdAt));
  return Response.json({ policies });
}

export async function POST(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "request body must be valid JSON" }, { status: 400 }); }
  const parsed = parseValidationPolicyInput(body);
  if (!parsed.ok) return Response.json({ error: "invalid request", details: parsed.errors }, { status: 400 });
  const [product] = await getDb().select({ id: cellProducts.id }).from(cellProducts)
    .where(and(eq(cellProducts.id, parsed.value.productId), eq(cellProducts.userId, owner))).limit(1);
  if (!product) return Response.json({ error: "Product not found" }, { status: 404 });
  const policy = { id: crypto.randomUUID(), userId: owner, ...parsed.value, status: "draft" as const, approvedAt: null, createdAt: new Date().toISOString() };
  try { await getDb().insert(datasetValidationPolicies).values(policy); }
  catch { return Response.json({ error: "Policy version already exists for this product" }, { status: 409 }); }
  return Response.json({ policy }, { status: 201 });
}
