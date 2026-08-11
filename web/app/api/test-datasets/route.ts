import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { cellProducts, cellSamples, testDatasets } from "../../../db/schema";
import { parseDatasetInput, sampleReuseConflict } from "../../../lib/catalog";
import {
  MAX_SOURCE_DATASET_BYTES,
  validateDatasetSource,
} from "../../../lib/dataset-source";
import { parseIdempotencyKey } from "../../../lib/runs";
import { sha256Hex } from "../../../lib/worker-api";

function ownerOf(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

export async function GET(request: Request) {
  const owner = ownerOf(request);
  if (!owner)
    return Response.json({ error: "Authentication required" }, { status: 401 });
  const datasets = await getDb()
    .select()
    .from(testDatasets)
    .where(eq(testDatasets.userId, owner))
    .orderBy(desc(testDatasets.createdAt));
  return Response.json({ datasets: datasets.map(publicDataset) });
}

export async function POST(request: Request) {
  const owner = ownerOf(request);
  if (!owner)
    return Response.json({ error: "Authentication required" }, { status: 401 });
  const idempotency = parseIdempotencyKey(request);
  if (!idempotency.ok || !idempotency.value) {
    return Response.json(
      { error: "A valid Idempotency-Key header is required" },
      { status: 400 },
    );
  }
  const db = getDb();
  const [existing] = await db
    .select()
    .from(testDatasets)
    .where(
      and(
        eq(testDatasets.userId, owner),
        eq(testDatasets.idempotencyKey, idempotency.value),
      ),
    )
    .limit(1);
  if (existing) return Response.json({ dataset: publicDataset(existing) });
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_SOURCE_DATASET_BYTES + 1024 * 1024
  ) {
    return Response.json(
      { error: "multipart upload exceeds the V0.2 request limit" },
      { status: 413 },
    );
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "request body must be multipart form data" },
      { status: 400 },
    );
  }
  const source = form.get("sourceFile");
  if (typeof source === "string" || source === null) {
    return Response.json({ error: "sourceFile is required" }, { status: 400 });
  }
  if (source.size > MAX_SOURCE_DATASET_BYTES) {
    return Response.json(
      { error: "source file exceeds the 25 MiB V0.2 limit" },
      { status: 413 },
    );
  }
  const payload: Record<string, unknown> = Object.fromEntries(
    [...form.entries()].filter(([key]) => key !== "sourceFile"),
  );
  payload.fileName = source.name;
  payload.checksumSha256 = null;
  payload.rowCount = null;
  const parsed = parseDatasetInput(payload);
  if (!parsed.ok)
    return Response.json(
      { error: "invalid request", details: parsed.errors },
      { status: 400 },
    );
  const product = await getDb()
    .select({ id: cellProducts.id })
    .from(cellProducts)
    .where(
      and(
        eq(cellProducts.id, parsed.value.productId),
        eq(cellProducts.userId, owner),
      ),
    )
    .limit(1);
  if (!product.length)
    return Response.json({ error: "Product not found" }, { status: 404 });
  const content = await source.arrayBuffer();
  const sourceValidation = validateDatasetSource(
    source.name,
    new Uint8Array(content),
  );
  if (!sourceValidation.ok)
    return Response.json({ error: sourceValidation.error }, { status: 400 });
  const checksumSha256 = await sha256Hex(content);
  const now = new Date().toISOString();
  const existingSample = await db
    .select()
    .from(cellSamples)
    .where(
      and(
        eq(cellSamples.userId, owner),
        eq(cellSamples.sampleCode, parsed.value.sampleCode),
      ),
    )
    .limit(1);
  if (existingSample.length) {
    const conflict = sampleReuseConflict(existingSample[0], parsed.value);
    if (conflict) return Response.json({ error: conflict }, { status: 409 });
  }
  const sample = existingSample[0] ?? {
    id: crypto.randomUUID(),
    userId: owner,
    productId: parsed.value.productId,
    sampleCode: parsed.value.sampleCode,
    batchCode: parsed.value.batchCode,
    createdAt: now,
  };
  const {
    sampleCode: _sampleCode,
    batchCode: _batchCode,
    ...input
  } = parsed.value;
  void _sampleCode;
  void _batchCode;
  const datasetId = crypto.randomUUID();
  const objectKey = `datasets/${datasetId}/source`;
  const dataset = {
    id: datasetId,
    userId: owner,
    sampleId: sample.id,
    schemaVersion: "V0.2",
    ...input,
    sourceContentType: sourceValidation.contentType,
    byteCount: content.byteLength,
    storageUri: `r2://STUDY_ARTIFACTS/${objectKey}`,
    checksumSha256,
    rowCount: sourceValidation.rowCount,
    sourceColumnsJson:
      sourceValidation.sourceColumns === null
        ? null
        : JSON.stringify(sourceValidation.sourceColumns),
    status: "registered" as const,
    idempotencyKey: idempotency.value,
    createdAt: now,
  };
  await env.STUDY_ARTIFACTS.put(objectKey, content, {
    httpMetadata: { contentType: sourceValidation.contentType },
    customMetadata: { datasetId, sha256: checksumSha256, immutable: "true" },
  });
  try {
    if (existingSample.length) await db.insert(testDatasets).values(dataset);
    else
      await db.batch([
        db.insert(cellSamples).values(sample),
        db.insert(testDatasets).values(dataset),
      ]);
  } catch {
    await env.STUDY_ARTIFACTS.delete(objectKey);
    return Response.json(
      { error: "Sample or dataset conflicts with an existing record" },
      { status: 409 },
    );
  }
  return Response.json({ dataset: publicDataset(dataset) }, { status: 201 });
}

function publicDataset(
  dataset: typeof testDatasets.$inferSelect | typeof testDatasets.$inferInsert,
) {
  const {
    storageUri: _storageUri,
    idempotencyKey: _idempotencyKey,
    sourceColumnsJson,
    ...safe
  } = dataset;
  void _storageUri;
  void _idempotencyKey;
  let sourceColumns: string[] | null = null;
  if (typeof sourceColumnsJson === "string") {
    try {
      const parsed = JSON.parse(sourceColumnsJson);
      if (
        Array.isArray(parsed) &&
        parsed.every((item) => typeof item === "string")
      )
        sourceColumns = parsed;
    } catch {
      /* Legacy or corrupt metadata remains unavailable rather than being guessed. */
    }
  }
  return {
    ...safe,
    sourceColumns,
    sourceHref: `/api/test-datasets/${encodeURIComponent(dataset.id!)}/source`,
  };
}
