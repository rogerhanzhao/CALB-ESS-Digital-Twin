import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { cellProducts, cellSamples, testDatasets } from "../../../db/schema";
import { parseDatasetInput, sampleReuseConflict } from "../../../lib/catalog";

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
  const now = new Date().toISOString();
  const db = getDb();
  const existingSample = await db.select().from(cellSamples).where(and(eq(cellSamples.userId, owner), eq(cellSamples.sampleCode, parsed.value.sampleCode))).limit(1);
  if (existingSample.length) {
    const conflict = sampleReuseConflict(existingSample[0], parsed.value);
    if (conflict) return Response.json({ error: conflict }, { status: 409 });
  }
  const sample = existingSample[0] ?? { id: crypto.randomUUID(), userId: owner, productId: parsed.value.productId, sampleCode: parsed.value.sampleCode, batchCode: parsed.value.batchCode, createdAt: now };
  const { sampleCode: _sampleCode, batchCode: _batchCode, ...input } = parsed.value;
  void _sampleCode; void _batchCode;
  const dataset = { id: crypto.randomUUID(), userId: owner, sampleId: sample.id, schemaVersion: "V0.2", ...input, storageUri: null, status: "registered", createdAt: now };
  try {
    if (existingSample.length) await db.insert(testDatasets).values(dataset);
    else await db.batch([db.insert(cellSamples).values(sample), db.insert(testDatasets).values(dataset)]);
  } catch {
    return Response.json({ error: "Sample or dataset conflicts with an existing record" }, { status: 409 });
  }
  return Response.json({ dataset }, { status: 201 });
}
