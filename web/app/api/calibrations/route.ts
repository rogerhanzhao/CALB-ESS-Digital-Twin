import { env } from "cloudflare:workers";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db";
import {
  calibrationInputs,
  calibrations,
  cellProducts,
  datasetRevisions,
  testDatasets,
} from "../../../db/schema";
import {
  canonicalArtifactBytes,
  parseCalibrationRegistration,
} from "../../../lib/calibration-registry";
import { sha256Hex } from "../../../lib/worker-api";

const MAX_CALIBRATION_BYTES = 5 * 1024 * 1024;

function ownerOf(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

export async function GET(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const rows = await getDb()
    .select()
    .from(calibrations)
    .where(eq(calibrations.userId, owner))
    .orderBy(desc(calibrations.createdAt));
  return Response.json({ calibrations: rows });
}

export async function POST(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CALIBRATION_BYTES) {
    return Response.json({ error: "calibration registration exceeds 5 MiB" }, { status: 413 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = parseCalibrationRegistration(payload);
  if (!parsed.ok) {
    return Response.json({ error: "invalid request", details: parsed.errors }, { status: 400 });
  }
  const { productId, artifact } = parsed.value;
  const db = getDb();
  const [product] = await db
    .select({ id: cellProducts.id, revision: cellProducts.revision })
    .from(cellProducts)
    .where(and(eq(cellProducts.id, productId), eq(cellProducts.userId, owner)))
    .limit(1);
  if (!product) return Response.json({ error: "Product not found" }, { status: 404 });
  if (product.revision !== artifact.product_revision) {
    return Response.json(
      { error: "calibration product revision does not match the selected product" },
      { status: 409 },
    );
  }

  const evidence = await db
    .select({
      id: datasetRevisions.id,
      validationStatus: datasetRevisions.validationStatus,
      productId: testDatasets.productId,
    })
    .from(datasetRevisions)
    .innerJoin(testDatasets, eq(datasetRevisions.datasetId, testDatasets.id))
    .where(
      and(
        eq(datasetRevisions.userId, owner),
        inArray(datasetRevisions.id, artifact.dataset_revision_ids),
      ),
    );
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const invalidEvidence = artifact.dataset_revision_ids.filter((id) => {
    const item = evidenceById.get(id);
    return (
      !item ||
      item.productId !== productId ||
      !["pass", "warning"].includes(item.validationStatus)
    );
  });
  if (invalidEvidence.length) {
    return Response.json(
      { error: "calibration evidence is missing, rejected, pending, or belongs to another product" },
      { status: 409 },
    );
  }

  const content = canonicalArtifactBytes(artifact);
  if (content.byteLength > MAX_CALIBRATION_BYTES) {
    return Response.json({ error: "calibration artifact exceeds 5 MiB" }, { status: 413 });
  }
  const contentBuffer = content.buffer.slice(
    content.byteOffset,
    content.byteOffset + content.byteLength,
  ) as ArrayBuffer;
  const checksum = await sha256Hex(contentBuffer);
  const calibrationRowId = crypto.randomUUID();
  const objectKey = `calibrations/${calibrationRowId}/calibration-result.json`;
  await env.STUDY_ARTIFACTS.put(objectKey, content, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      calibrationRowId,
      artifactCalibrationId: artifact.calibration_id,
      sha256: checksum,
    },
  });

  const envelope = artifact.validity_envelope;
  const limits = envelope.approved_extrapolation_limits;
  const row = {
    id: calibrationRowId,
    userId: owner,
    productId,
    artifactCalibrationId: artifact.calibration_id,
    modelVersion: artifact.model_version,
    codeRevision: artifact.code_revision,
    schemaVersion: artifact.schema_version,
    artifactObjectKey: objectKey,
    artifactChecksumSha256: checksum,
    artifactSizeBytes: content.byteLength,
    approvalEligible: Number(artifact.approval_eligible),
    fitError: artifact.metrics.validation_rmse_fraction,
    cellTemperatureMinC: envelope.temperature_min_c,
    cellTemperatureMaxC: envelope.temperature_max_c,
    chargeRateMinC: envelope.charge_c_rate_min,
    chargeRateMaxC: envelope.charge_c_rate_max,
    dischargeRateMinC: envelope.discharge_c_rate_min,
    dischargeRateMaxC: envelope.discharge_c_rate_max,
    depthOfDischargeMin: envelope.depth_of_discharge_min,
    depthOfDischargeMax: envelope.depth_of_discharge_max,
    socMin: null,
    socMax: null,
    meanSocMin: envelope.mean_soc_min,
    meanSocMax: envelope.mean_soc_max,
    maxCalendarDays: limits.maximum_elapsed_days,
    maxCycles: limits.maximum_cycle_count,
    maxEquivalentFullCycles: limits.maximum_equivalent_full_cycles,
    maxAbsoluteThroughputAh: limits.maximum_absolute_throughput_ah,
    status: "under_review" as const,
    createdAt: new Date().toISOString(),
  };
  try {
    await db.batch([
      db.insert(calibrations).values(row),
      ...artifact.dataset_revision_ids.map((datasetRevisionId) =>
        db.insert(calibrationInputs).values({
          calibrationId: calibrationRowId,
          datasetRevisionId,
        }),
      ),
    ]);
  } catch {
    await env.STUDY_ARTIFACTS.delete(objectKey);
    return Response.json(
      { error: "Calibration artifact or evidence has already been registered" },
      { status: 409 },
    );
  }
  return Response.json({ calibration: row }, { status: 201 });
}
