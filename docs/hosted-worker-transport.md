# V0.2 Hosted worker transport

The hosted control plane exposes private transports for standard-study, study-comparison, and dataset-revision workers. Browser identity
and compute-worker identity are separate: product APIs use authenticated Sites user headers, while
`/api/worker/**` requires the server-managed `WORKER_API_TOKEN` bearer secret. The secret is never
present in client code or `.openai/hosting.json`.

## Storage boundary

- D1 stores run ownership, status, lease metadata, payload checksum/pointer, result summary, and
  artifact metadata.
- The private `STUDY_ARTIFACTS` R2 binding stores exact job payload bytes and immutable result
  bundle bytes.
- A Python worker keeps local files only until upload. Client APIs never receive worker-local
  `file:` URIs.

## Protocol

1. `POST /api/worker/jobs/claim` conditionally claims the oldest queued or expired-lease
   `standard-study` run and verifies its R2 payload checksum and contract identity.
2. `POST /api/worker/jobs/{id}/heartbeat` extends a lease only for its current owner.
3. `PUT /api/worker/jobs/{id}/artifacts/{kind}` accepts only the four standard-study JSON files,
   verifies their SHA-256 and 10 MiB size limit, and writes private R2 objects.
4. `POST /api/worker/jobs/{id}/complete` validates the complete result contract, checks every R2
   object again, then records four artifacts and the terminal run summary in one D1 batch.
5. `POST /api/worker/jobs/{id}/fail` records bounded failure detail without terminating the worker.

The Python worker selects this transport with `--remote-base-url`. Its bearer token comes only from
the `CALB_ESS_WORKER_API_TOKEN` process environment. Non-local HTTP endpoints are rejected; hosted
workers require HTTPS.

Comparison workers run as a separate process with
`--remote-job-kind study-comparison`. They poll `/api/worker/comparisons/**`, upload exactly the
three comparison evidence files, and never claim or mutate standard-study rows. This separation
keeps small version-comparison workloads from changing the semantics or capacity policy of the
numerical simulation queue.

Comparison completion is evidence-derived, not worker-trusted. After checking R2 metadata, the
control plane re-hashes and parses all three JSON files, validates their generated schemas,
cross-checks request/result/manifest identities and manifest file records, independently recomputes
every annual capacity delta, classification, validity transition and issue-set change from the two
source study trajectories, and compares the aggregate result with the worker completion summary.
Any mismatch leaves the comparison running and returns a conflict instead of publishing evidence.

Dataset revision workers form a third, independent queue selected with
`--remote-job-kind dataset-revision`. The control plane accepts only an owned CSV source object and
an approved, product-matched validation policy. A claim returns a short-lived worker-authorized
download URL; both the control plane and Python worker verify the original byte count and SHA-256
before processing. The worker then creates the immutable revision bundle and uploads the four
required JSON evidence files, plus `canonical.csv` and `cycle-metrics.json` only when the declared
outcome makes those files available. Completion re-hashes every R2 object and cross-checks the
request, result, validation report, manifest, source identity, and exact manifest file set before
publishing the D1 summary. A `pass` result alone is calibration-eligible; `warning` remains visible
for engineering review and `reject` publishes no canonical dataset.

This queue is intentionally sized for occasional engineering batches rather than many concurrent
end-user simulations. One CPU worker is sufficient for ordinary CSV validation and cycle-metric
extraction; memory use is bounded primarily by the 25 MiB source limit and pandas parsing overhead.
GPU capacity is not used by this stage. Additional workers improve turnaround for newly imported
test campaigns but do not change evidence semantics because claims are lease-owned and results are
content-addressed.

## Deliberately unresolved submission boundary

This change does not let a browser invent a full calibration artifact and enqueue it. A truthful
standard-study publisher must prove these values from owned, versioned records:

- cell product revision and nominal capacity;
- released standard scenario, including availability and charge/discharge C-rate;
- calibration artifact, input dataset revisions, approval state, parameters, and approved
  extrapolation limits;
- exact worker code revision requested for reproducibility.

The current web tables do not retain every field. Until that data-model slice is implemented,
payload objects may be provisioned only by an engineering/admin process; the ordinary simulation
form remains explicitly demonstrative. This prevents a convenient UI from creating a study whose
stored evidence cannot reproduce its calculation.

## Operations

- Rotate `WORKER_API_TOKEN` through Sites runtime values; do not commit it.
- Give the external worker the same value as `CALB_ESS_WORKER_API_TOKEN`; keep it only in the
  host secret store or an uncommitted `.env` file.
- `deploy/worker/compose.yaml` starts one process for each independent queue. Copy
  `deploy/worker/.env.example` to `.env`, replace both values, then run `docker compose up -d
  --build` from that directory. The template limits dataset-revision and comparison workers to
  2 CPU / 4 GiB each and the numerical standard-study worker to 4 CPU / 8 GiB.
- Each process atomically refreshes `/var/run/calb-worker/status.json`. Docker marks the container
  unhealthy if that file stops updating for 90 seconds. The JSON also distinguishes `idle` from
  `transport_error` and exposes the consecutive outage count.
- Transport failures use capped exponential backoff rather than polling the control plane every
  two seconds throughout an outage.
- Apply the D1 migration before starting remote workers.
- Configure an R2 lifecycle rule for abandoned uploads while retaining completed evidence bundles.
- Alert on expired leases, repeated attempts, payload integrity failures, and orphaned uploads.
