import assert from "node:assert/strict";
import test from "node:test";

import {
  duplicateSourceColumns,
  mappingTemplate,
  missingCanonicalColumns,
  parseMappingJson,
  unitOptionsFor,
} from "../lib/dataset-mapping.ts";

test("cycle-aging template includes every physically required canonical column", () => {
  const mappings = mappingTemplate("cycle_aging", null);
  assert.deepEqual(
    mappings.map((item) => item.canonical_column),
    [
      "timestamp",
      "elapsed_time_s",
      "voltage_v",
      "current_a",
      "cell_temperature_c",
      "ambient_temperature_c",
      "capacity_ah",
      "cycle_index",
      "step_index",
    ],
  );
  assert.deepEqual(missingCanonicalColumns(mappings), []);
});

test("advanced JSON parsing fails closed", () => {
  assert.equal(parseMappingJson("not-json"), null);
  assert.equal(parseMappingJson('[{"source_column":"time"}]'), null);
  assert.equal(
    parseMappingJson(JSON.stringify(mappingTemplate("temperature", null)))
      ?.length,
    6,
  );
});

test("source-aware template matches exact names case-insensitively and never invents missing sources", () => {
  const mappings = mappingTemplate("calendar_aging", [
    "Timestamp",
    "voltage_v",
  ]);
  assert.equal(mappings[0].source_column, "Timestamp");
  assert.equal(
    mappings.find((item) => item.canonical_column === "voltage_v")
      ?.source_column,
    "voltage_v",
  );
  assert.ok(missingCanonicalColumns(mappings).includes("capacity_ah"));
});

test("unit choices are limited to supported physical conversions", () => {
  const mappings = mappingTemplate("cycle_aging", null);
  assert.deepEqual(
    unitOptionsFor(
      mappings.find((item) => item.canonical_column === "voltage_v")!,
    ),
    ["V", "mV"],
  );
  assert.deepEqual(
    unitOptionsFor(
      mappings.find((item) => item.canonical_column === "cell_temperature_c")!,
    ),
    ["degC", "K"],
  );
});

test("one physical source column cannot feed two canonical fields", () => {
  const mappings = mappingTemplate("temperature", null);
  mappings[1].source_column = mappings[0].source_column;
  assert.deepEqual(duplicateSourceColumns(mappings), ["timestamp"]);
});
