import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SOURCE_DATASET_BYTES,
  validateDatasetSource,
} from "../lib/dataset-source.ts";

test("accepts canonical UTF-8 CSV and derives data row count on the server", () => {
  const bytes = new TextEncoder().encode(
    "timestamp,voltage_v,current_a\n2026-01-01T00:00:00Z,3.2,-10\n2026-01-01T00:00:01Z,3.1,-10\n",
  );
  assert.deepEqual(validateDatasetSource("cycle.csv", bytes), {
    ok: true,
    contentType: "text/csv; charset=utf-8",
    rowCount: 2,
    sourceColumns: ["timestamp", "voltage_v", "current_a"],
  });
});

test("rejects empty, malformed, non-UTF-8 and unsupported source files", () => {
  assert.equal(validateDatasetSource("empty.csv", new Uint8Array()).ok, false);
  assert.equal(
    validateDatasetSource(
      "header.csv",
      new TextEncoder().encode("timestamp\nvalue\n"),
    ).ok,
    false,
  );
  assert.equal(
    validateDatasetSource("bad.csv", Uint8Array.from([0xff, 0xfe, 0xfd])).ok,
    false,
  );
  assert.equal(
    validateDatasetSource("test.xls", new TextEncoder().encode("legacy")).ok,
    false,
  );
});

test("XLSX registration requires a ZIP signature and remains unparsed", () => {
  assert.deepEqual(
    validateDatasetSource(
      "test.xlsx",
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
    ),
    {
      ok: true,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      rowCount: null,
      sourceColumns: null,
    },
  );
  assert.equal(
    validateDatasetSource("fake.xlsx", new TextEncoder().encode("not a zip"))
      .ok,
    false,
  );
});

test("CSV header evidence supports quoted names and rejects ambiguous columns", () => {
  const quoted = validateDatasetSource(
    "quoted.csv",
    new TextEncoder().encode(
      '"time, UTC",voltage_v\n2026-01-01T00:00:00Z,3.2\n',
    ),
  );
  assert.equal(quoted.ok, true);
  if (quoted.ok)
    assert.deepEqual(quoted.sourceColumns, ["time, UTC", "voltage_v"]);
  assert.equal(
    validateDatasetSource(
      "duplicate.csv",
      new TextEncoder().encode("time,time\n1,2\n"),
    ).ok,
    false,
  );
  assert.equal(
    validateDatasetSource(
      "empty-name.csv",
      new TextEncoder().encode("time,\n1,2\n"),
    ).ok,
    false,
  );
});

test("source evidence has an explicit memory and request-size ceiling", () => {
  assert.equal(
    validateDatasetSource(
      "large.csv",
      new Uint8Array(MAX_SOURCE_DATASET_BYTES + 1),
    ).ok,
    false,
  );
});
