import assert from "node:assert/strict";
import test from "node:test";

import {
  comparisonJobPayloadIsValid,
  comparisonResultObjectKey,
  parseComparisonWorkerCompletion,
  parseWorkerCompletion,
  parseWorkerIdentity,
  resultObjectKey,
  sha256Hex,
  standardStudyJobPayloadIsValid,
  workerRequestIsAuthorized,
} from "../lib/worker-api.ts";

const RUN_ID = "1f27154f-3392-48aa-a004-5b18315b0339";
const CHECKSUMS = {
  "manifest.json": "a".repeat(64),
  "scenario-exposure.json": "b".repeat(64),
  "soh-result.json": "c".repeat(64),
  "study-request.json": "d".repeat(64),
};
const COMPARISON_CHECKSUMS = {
  "comparison-manifest.json": "e".repeat(64),
  "comparison-request.json": "f".repeat(64),
  "comparison-result.json": "0".repeat(64),
};

function completion() {
  const artifacts = Object.entries(CHECKSUMS).map(([kind, checksumSha256]) => ({
    kind,
    objectKey: resultObjectKey(RUN_ID, kind as keyof typeof CHECKSUMS),
    contentType: "application/json",
    sizeBytes: 100,
    checksumSha256,
  }));
  return {
    workerId: "worker-a:123",
    result: {
      contract_version: "2.0",
      job_id: RUN_ID,
      engine: "standard-study",
      model_version: "semi-empirical-1",
      code_revision: "abcdef1",
      status: "completed",
      points: [],
      end_soh: 0.81,
      within_validity_envelope: true,
      uncertainty: { confidence_level: 0.95, source: "not_available" },
      metrics: {},
      warnings: [],
      artifact_checksums: CHECKSUMS,
    },
    artifacts,
  };
}

test("worker bearer authentication rejects absent and incorrect secrets", async () => {
  const absent = new Request("https://app.local/api/worker/jobs/claim");
  const wrong = new Request("https://app.local/api/worker/jobs/claim", {
    headers: { authorization: "Bearer wrong" },
  });
  const correct = new Request("https://app.local/api/worker/jobs/claim", {
    headers: { authorization: "Bearer correct" },
  });
  assert.equal(await workerRequestIsAuthorized(absent, "correct"), false);
  assert.equal(await workerRequestIsAuthorized(wrong, "correct"), false);
  assert.equal(await workerRequestIsAuthorized(correct, "correct"), true);
  assert.equal(await workerRequestIsAuthorized(correct, undefined), false);
});

test("worker identity bounds lease duration and identifier shape", () => {
  assert.deepEqual(parseWorkerIdentity({ workerId: "host-1:123", leaseSeconds: 60 }), {
    workerId: "host-1:123",
    leaseSeconds: 60,
  });
  assert.equal(parseWorkerIdentity({ workerId: "bad worker", leaseSeconds: 60 }), null);
  assert.equal(parseWorkerIdentity({ workerId: "host", leaseSeconds: 5 }), null);
  assert.equal(parseWorkerIdentity({ workerId: "host", leaseSeconds: 301 }), null);
});

test("claim accepts only an outer contract V3 standard-study payload for the same run", () => {
  const payload = {
    contract_version: "3.0",
    job_id: RUN_ID,
    scenario_id: crypto.randomUUID(),
    user_id: "alex",
    engine: "standard-study",
    model_version: "semi-empirical-1",
    code_revision: "abcdef1",
    scenario: null,
    standard_study_request: { schema_version: "V0.2" },
    submitted_at: "2026-08-12T00:00:00Z",
  };
  assert.equal(standardStudyJobPayloadIsValid(payload, RUN_ID), true);
  assert.equal(standardStudyJobPayloadIsValid({ ...payload, engine: "stub" }, RUN_ID), false);
  assert.equal(standardStudyJobPayloadIsValid(payload, crypto.randomUUID()), false);
});

test("completion requires four exact artifacts tied to result checksums", () => {
  assert.ok(parseWorkerCompletion(completion(), RUN_ID));

  const missing = completion();
  missing.artifacts.pop();
  assert.equal(parseWorkerCompletion(missing, RUN_ID), null);

  const duplicate = completion();
  duplicate.artifacts[3] = duplicate.artifacts[0];
  assert.equal(parseWorkerCompletion(duplicate, RUN_ID), null);

  const mismatch = completion();
  mismatch.artifacts[0].checksumSha256 = "e".repeat(64);
  assert.equal(parseWorkerCompletion(mismatch, RUN_ID), null);

  const wrongJob = completion();
  assert.equal(parseWorkerCompletion(wrongJob, crypto.randomUUID()), null);
});

test("comparison claim requires the independent contract and matching identity", () => {
  const payload = {
    contract_version: "1.0",
    job_id: RUN_ID,
    user_id: "alex",
    engine: "study-comparison",
    model_version: "study-comparison-V0.2",
    code_revision: "abcdef1",
    study_comparison_request: {},
    submitted_at: "2026-08-12T00:00:00Z",
  };
  assert.equal(comparisonJobPayloadIsValid(payload, RUN_ID), true);
  assert.equal(comparisonJobPayloadIsValid({ ...payload, engine: "standard-study" }, RUN_ID), false);
  assert.equal(comparisonJobPayloadIsValid(payload, crypto.randomUUID()), false);
});

test("comparison completion requires three exact immutable artifacts", () => {
  const artifacts = Object.entries(COMPARISON_CHECKSUMS).map(([kind, checksumSha256]) => ({
    kind,
    objectKey: comparisonResultObjectKey(RUN_ID, kind as keyof typeof COMPARISON_CHECKSUMS),
    contentType: "application/json",
    sizeBytes: 100,
    checksumSha256,
  }));
  const value = {
    workerId: "comparison-worker:123",
    result: {
      contract_version: "1.0",
      job_id: RUN_ID,
      engine: "study-comparison",
      model_version: "study-comparison-V0.2",
      code_revision: "abcdef1",
      status: "completed",
      comparison_version: "comparison-V1",
      final_capacity_delta_fraction: -0.01,
      maximum_absolute_capacity_delta_fraction: 0.02,
      artifact_checksums: COMPARISON_CHECKSUMS,
      completed_at: "2026-08-12T00:00:00Z",
    },
    artifacts,
  };
  assert.ok(parseComparisonWorkerCompletion(value, RUN_ID));
  assert.equal(parseComparisonWorkerCompletion({ ...value, artifacts: artifacts.slice(1) }, RUN_ID), null);
  assert.equal(parseComparisonWorkerCompletion(value, crypto.randomUUID()), null);
});

test("SHA-256 helper hashes exact bytes", async () => {
  const content = new TextEncoder().encode("CALB\n");
  assert.equal(
    await sha256Hex(content.buffer),
    "bf799300e36a2ae05b4e26eb34d0ed168bda5db132e68c261ce45dab8e200099",
  );
});
