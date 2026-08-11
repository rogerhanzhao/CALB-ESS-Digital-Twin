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

## Next integration boundary

The web control plane still needs a transport adapter that:

1. constructs contract `3.0` only from a released standard scenario and an approved or explicitly
   exploratory calibration artifact;
2. submits the exact JSON payload under an idempotency key;
3. mirrors lease, heartbeat, progress, terminal result, and artifact registrations into `runs` and
   `run_artifacts`;
4. serves bundle files through authorized object-storage URLs.

Until that adapter lands, the web submission route remains a demonstrator and must not label its
output as a standard-study result.
