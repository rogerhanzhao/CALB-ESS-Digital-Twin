import assert from "node:assert/strict";
import test from "node:test";
import { parseDatasetInput, parseProductInput, sampleReuseConflict } from "../lib/catalog.ts";

test("product validation accepts a bounded LFP cell record", () => {
  const result = parseProductInput({ manufacturer: "CALB", model: "sample", chemistry: "LFP", nominalCapacityAh: 314, nominalVoltageV: 3.2, revision: "R1" });
  assert.equal(result.ok, true);
});

test("product validation rejects invented or invalid physical values", () => {
  const result = parseProductInput({ manufacturer: "", model: "sample", chemistry: "NMC", nominalCapacityAh: -1, nominalVoltageV: 30, revision: "R1" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.length >= 4);
});

test("dataset validation requires provenance and validates checksums", () => {
  const result = parseDatasetInput({ productId: "p1", sampleCode: "S1", name: "cycle batch", testType: "cycle_aging", batchCode: "B1", sourceLab: "Lab A", equipmentId: "CH-1", operator: "operator", testStartedAt: "2026-01-01T00:00:00Z", testEndedAt: "2026-01-02T00:00:00Z", fileName: "cycle.csv", unitSchema: "time:s,current:A,voltage:V", checksumSha256: "bad" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.includes("SHA-256")));
});

test("sample reuse accepts only the same product and manufacturing batch", () => {
  const existing = { productId: "p1", batchCode: "B1" };
  assert.equal(sampleReuseConflict(existing, { productId: "p1", batchCode: "B1" }), null);
  assert.match(sampleReuseConflict(existing, { productId: "p2", batchCode: "B1" }) ?? "", /product/);
  assert.match(sampleReuseConflict(existing, { productId: "p1", batchCode: "B2" }) ?? "", /batch/);
});
