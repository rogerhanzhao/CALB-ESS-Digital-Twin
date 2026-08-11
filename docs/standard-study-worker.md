# V0.2 Standard-study worker adapter

This adapter is the first real execution path from a durable job to a versioned engineering
result. It is intended for the platform's normal operating model: a small number of studies are
rerun when a product, dataset revision, calibration, or standard duty cycle changes.

## Execution contract

`JobPayload` contract `3.0` adds the `standard-study` engine. Such a job carries one complete
`StandardStudyRequest` and deliberately carries no generic `ScenarioInput`; two parallel input
surfaces could disagree about temperature, SOC window, DoD, or horizon. The embedded request is
validated again by the Python worker. Its standalone JSON Schema is exported as
`contracts/generated/standard-study-request.schema.json` for control-plane validation.

The job-level `model_version` must equal the embedded calibration model version. A mismatch fails
the job before an artifact directory is created.

## Durable outputs

The worker writes an immutable bundle below an operator-selected artifact root:

```text
<artifact-root>/<job-id>/standard-study/
  study-request.json
  scenario-exposure.json
  soh-result.json
  manifest.json
```

The directory is created atomically. If a lease expires after the directory is published but
before the queue row is completed, the next worker verifies every manifest checksum and confirms
the stored request is identical before reusing it. It never overwrites the bundle.

Completion and artifact registration are one SQLite transaction. The queue result carries only
the summary required for job lists; the complete annual series and evidence remain in the bundle.
All four files are registered with URI, media type, byte count, and SHA-256. `warranty_eligible`
remains false: engineering review eligibility is not a warranty approval.

## Local operation

```powershell
python -m compute.worker `
  --db data/interim/jobs.sqlite3 `
  --artifact-root data/processed/studies
```

The SQLite queue and file URI registry are a deterministic developer/pilot adapter. Hosted
deployment must translate the same payload and artifact records to the control-plane queue,
database, and object-storage bindings; it must not expose a worker's local file URI to clients.

## Hosted control-plane publisher

`POST /api/standard-studies` now constructs contract `3.0` only from an authenticated owner's
released product, released standard scenario, and approved calibration. The caller supplies an
explicit ISO study start date and a required idempotency key. Before queueing, the publisher
re-reads the exact calibration bytes from private R2, verifies size and SHA-256, validates the
generated schemas, and checks every embedded identity against D1.

The exact job payload is stored at `runs/{run-id}/job-payload.json`; D1 receives the linked
scenario and queued run in one batch. If persistence loses a race, the newly written object is
removed. The hosted worker transport then mirrors lease, heartbeat, terminal result, and all four
artifact registrations into `runs` and `run_artifacts`.

The older `POST /api/simulations` route remains a visibly separate demonstrator for ad-hoc UI
exploration. It cannot label or promote its output as a standard-study result.

## Result evidence access

`GET /api/simulations/{run-id}` returns the authenticated owner's run, execution provenance,
and artifact metadata. The metadata includes the contract version, payload checksum, worker,
attempt count, validity-envelope verdict, file checksum, and byte count.

Artifact bytes are served only through
`GET /api/simulations/{run-id}/artifacts/{kind}`. The route joins the artifact back to its owned
run, accepts only the private `STUDY_ARTIFACTS` URI namespace, reads the R2 object, and recomputes
its SHA-256 and byte count before returning it. `?download=1` adds a safe attachment filename;
the R2 object key is never presented as a public URL.

The Web result card reads `soh-result.json` from this authorized route and renders the annual
capacity trajectory, envelope status, engine and code revision, engineering-review eligibility,
and links to all four immutable evidence files. `warranty_eligible = false` remains explicit:
an engineering-reviewable trajectory is not itself a commercial warranty approval.
