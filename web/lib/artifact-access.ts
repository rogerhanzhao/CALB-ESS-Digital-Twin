const R2_URI_PREFIX = "r2://STUDY_ARTIFACTS/";
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,120}$/;

export function r2ObjectKeyFromUri(uri: string): string | null {
  if (!uri.startsWith(R2_URI_PREFIX)) return null;
  const key = uri.slice(R2_URI_PREFIX.length);
  if (!key || key.startsWith("/") || key.includes("\\") || key.split("/").includes("..")) {
    return null;
  }
  return key;
}

export function artifactDownloadName(kind: string): string {
  return SAFE_FILE_NAME.test(kind) ? kind : "study-artifact.json";
}
