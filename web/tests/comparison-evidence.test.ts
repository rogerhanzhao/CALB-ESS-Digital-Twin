import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifyComparisonEvidenceBundle } from "../lib/comparison-evidence.ts";
import {
  comparisonResultObjectKey,
  sha256Hex,
  type ComparisonWorkerCompletion,
  type StudyComparisonArtifactKind,
} from "../lib/worker-api.ts";

const COMPARISON_ID = "1f27154f-3392-48aa-a004-5b18315b0339";
const FIXTURE = new URL("./fixtures/comparison-evidence/", import.meta.url);

async function fixtureCompletion() {
  const kinds = [
    "comparison-manifest.json",
    "comparison-request.json",
    "comparison-result.json",
  ] as const;
  const buffers = Object.fromEntries(await Promise.all(kinds.map(async (kind) => [
    kind,
    await readFile(new URL(kind, FIXTURE)),
  ]))) as Record<StudyComparisonArtifactKind, Buffer>;
  const checksums = Object.fromEntries(await Promise.all(kinds.map(async (kind) => [
    kind,
    await sha256Hex(toArrayBuffer(buffers[kind])),
  ]))) as Record<StudyComparisonArtifactKind, string>;
  const result = JSON.parse(buffers["comparison-result.json"].toString("utf8"));
  const completion: ComparisonWorkerCompletion = {
    workerId: "comparison-worker:1",
    result: {
      contract_version: "1.0",
      job_id: COMPARISON_ID,
      engine: "study-comparison",
      model_version: "study-comparison-V0.2",
      code_revision: "compare123",
      status: "completed",
      comparison_version: result.comparison_version,
      final_capacity_delta_fraction: result.final_capacity_delta_fraction,
      maximum_absolute_capacity_delta_fraction: result.maximum_absolute_capacity_delta_fraction,
      artifact_checksums: checksums,
    },
    artifacts: kinds.map((kind) => ({
      kind,
      objectKey: comparisonResultObjectKey(COMPARISON_ID, kind),
      contentType: "application/json",
      sizeBytes: buffers[kind].byteLength,
      checksumSha256: checksums[kind],
    })),
  };
  return { buffers, completion };
}

test("accepts a comparison bundle whose summary is derived from its immutable studies", async () => {
  const { buffers, completion } = await fixtureCompletion();
  assert.deepEqual(await verifyComparisonEvidenceBundle({
    "comparison-manifest.json": toArrayBuffer(buffers["comparison-manifest.json"]),
    "comparison-request.json": toArrayBuffer(buffers["comparison-request.json"]),
    "comparison-result.json": toArrayBuffer(buffers["comparison-result.json"]),
  }, completion, { comparisonVersion: "comparison-V1", codeRevision: "compare123" }), { ok: true });
});

test("rejects a self-consistent checksum bundle with fabricated capacity deltas", async () => {
  const { buffers, completion } = await fixtureCompletion();
  const result = JSON.parse(buffers["comparison-result.json"].toString("utf8"));
  result.final_capacity_delta_fraction += 0.05;
  result.points.at(-1).capacity_delta_fraction += 0.05;
  const resultBytes = Buffer.from(`${JSON.stringify(result)}\n`);
  const checksum = await sha256Hex(toArrayBuffer(resultBytes));
  const manifest = JSON.parse(buffers["comparison-manifest.json"].toString("utf8"));
  const record = manifest.files.find((item: { file_name: string }) => item.file_name === "comparison-result.json");
  record.sha256 = checksum;
  record.byte_count = resultBytes.byteLength;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const manifestChecksum = await sha256Hex(toArrayBuffer(manifestBytes));
  completion.result.final_capacity_delta_fraction = result.final_capacity_delta_fraction;
  completion.result.artifact_checksums["comparison-result.json"] = checksum;
  completion.result.artifact_checksums["comparison-manifest.json"] = manifestChecksum;
  for (const artifact of completion.artifacts) {
    if (artifact.kind === "comparison-result.json") {
      artifact.sizeBytes = resultBytes.byteLength;
      artifact.checksumSha256 = checksum;
    }
    if (artifact.kind === "comparison-manifest.json") {
      artifact.sizeBytes = manifestBytes.byteLength;
      artifact.checksumSha256 = manifestChecksum;
    }
  }
  const verified = await verifyComparisonEvidenceBundle({
    "comparison-manifest.json": toArrayBuffer(manifestBytes),
    "comparison-request.json": toArrayBuffer(buffers["comparison-request.json"]),
    "comparison-result.json": toArrayBuffer(resultBytes),
  }, completion, { comparisonVersion: "comparison-V1", codeRevision: "compare123" });
  assert.equal(verified.ok, false);
  assert.match(verified.ok ? "" : verified.reason, /recomputed evidence deltas|source study trajectories/);
});

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
