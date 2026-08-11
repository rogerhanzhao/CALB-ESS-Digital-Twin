import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CONTRACT_RANGES } from "../lib/scenarios.ts";

/**
 * Cross-language consistency for the scenario bounds.
 *
 * Typing `CONTRACT_RANGES` against the generated `ScenarioInput` only ever checked the field
 * names. The numbers were restated by hand, so tightening a bound in `contracts/models.py`
 * would leave this side stale and still compile -- and the local tests, which asserted the
 * TypeScript constants against themselves, would have confirmed the stale values.
 *
 * This reads the generated JSON Schema, which is the same artifact the contract's own
 * byte-level drift test keeps current, and compares the actual numbers.
 */
const schemaPath = fileURLToPath(
  new URL("../../contracts/generated/job.schema.json", import.meta.url),
);

type SchemaNode = { minimum?: number; maximum?: number };

function scenarioProperties(): Record<string, SchemaNode> {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    $defs: { ScenarioInput: { properties: Record<string, SchemaNode>; required: string[] } };
  };
  return schema.$defs.ScenarioInput.properties;
}

test("every declared range matches the generated contract schema", () => {
  const properties = scenarioProperties();
  for (const [field, range] of Object.entries(CONTRACT_RANGES)) {
    const node = properties[field];
    assert.ok(node, `${field} is not a property of ScenarioInput in the generated schema`);
    assert.equal(node.minimum, range.min, `${field} minimum disagrees with the contract`);
    assert.equal(node.maximum, range.max, `${field} maximum disagrees with the contract`);
  }
});

// A bound that exists in the contract but not here is a dimension the control plane is not
// enforcing. That is allowed, but it should be a decision rather than an oversight, so the
// test names the fields deliberately left out.
test("every bounded contract field is either enforced here or knowingly skipped", () => {
  const knowinglySkipped = new Set<string>();
  const bounded = Object.entries(scenarioProperties())
    .filter(([, node]) => node.minimum !== undefined || node.maximum !== undefined)
    .map(([field]) => field);

  const unaccounted = bounded.filter(
    (field) => !(field in CONTRACT_RANGES) && !knowinglySkipped.has(field),
  );
  assert.deepEqual(unaccounted, [], `contract bounds with no control-plane counterpart: ${unaccounted.join(", ")}`);
});
