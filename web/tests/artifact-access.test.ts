import assert from "node:assert/strict";
import test from "node:test";

import { artifactDownloadName, r2ObjectKeyFromUri, sourceAttachmentDisposition } from "../lib/artifact-access.ts";

test("extracts only keys from the private study bucket namespace", () => {
  assert.equal(
    r2ObjectKeyFromUri("r2://STUDY_ARTIFACTS/runs/run-1/results/soh-result.json"),
    "runs/run-1/results/soh-result.json",
  );
  for (const uri of [
    "https://example.com/result.json",
    "r2://OTHER/key",
    "r2://STUDY_ARTIFACTS/../secret",
    "r2://STUDY_ARTIFACTS//absolute",
    "r2://STUDY_ARTIFACTS/runs\\secret",
  ]) {
    assert.equal(r2ObjectKeyFromUri(uri), null);
  }
});

test("source attachments preserve UTF-8 names without permitting header injection", () => {
  const disposition = sourceAttachmentDisposition("../循环数据\r\n.csv");
  assert.match(disposition, /^attachment; filename="/);
  assert.match(disposition, /filename\*=UTF-8''/);
  assert.doesNotMatch(disposition, /[\r\n]/);
  assert.doesNotMatch(disposition, /\.\.[/\\]/);
});

test("download names cannot inject response headers", () => {
  assert.equal(artifactDownloadName("soh-result.json"), "soh-result.json");
  assert.equal(artifactDownloadName("bad\r\nname.json"), "study-artifact.json");
});
