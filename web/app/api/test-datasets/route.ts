import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { cellProducts, testDatasets } from "../../../db/schema";
import { parseDatasetInput } from "../../../lib/catalog";

function ownerOf(request: Request) { return request.headers.get("oai-authenticated-user-id"); }

export async function GET(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const datasets = await getDb().select().from(testDatasets).where(eq(testDatasets.userId, owner)).orderBy(desc(testDatasets.createdAt));
  return Response.json({ datasets });
}

export async function POST(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  let payload: unknown;
  try { payload = await request.json(); } catch { return Response.json({ error: "request body must be valid JSON" }, { status: 400 }); }
  const parsed = parseDatasetInput(payload);
  if (!parsed.ok) return Response.json({ error: "invalid request", details: parsed.errors }, { status: 400 });
  const product = await getDb().select({ id: cellProducts.id }).from(cellProducts).where(and(eq(cellProducts.id, parsed.value.productId), eq(cellProducts.userId, owner))).limit(1);
  if (!product.length) return Response.json({ error: "Product not found" }, { status: 404 });
  const dataset = { id: crypto.randomUUID(), userId: owner, ...parsed.value, storageUri: null, status: "registered", createdAt: new Date().toISOString() };
  await getDb().insert(testDatasets).values(dataset);
  return Response.json({ dataset }, { status: 201 });
}
