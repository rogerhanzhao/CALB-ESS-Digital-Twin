# Deployment and compute capacity

## Service split

The production platform is split into a lightweight web control plane and one or more Python compute workers.

- The web control plane authenticates users, validates inputs, stores durable job records, exposes progress, and serves results.
- The job store remains authoritative when a browser closes or a user signs out.
- Python workers claim queued jobs, execute PyBaMM/SOH/dispatch calculations, checkpoint intermediate state, and upload result artifacts.
- A worker restart must resume from its latest checkpoint or safely retry an idempotent job.
- Hosted workers use HTTPS bearer-authenticated control-plane endpoints. D1 retains leases and
  summaries; private R2 stores payload and bundle bytes. Worker-local file URIs are never served.

The initial hosted web release includes the control-plane experience and persistent per-user job records. Its progress engine is a deployment-safe demonstrator until the Python worker service is connected; it must not be used for commercial warranty decisions.

## Hardware planning assumptions

Actual consumption depends on model order, mesh size, experiment length, solver tolerances, parameter sweeps, and Monte Carlo sample count. Benchmark with approved cell datasets before committing to an SLA.

| Deployment tier | Concurrent users | Web/API | PyBaMM workers | Storage | Intended use |
|---|---:|---|---|---|---|
| Developer | 1–3 | 2 vCPU, 4 GB RAM | 1 worker: 4 vCPU, 8 GB RAM | 20 GB SSD | Feature development and single-cell runs |
| Pilot | 5–20 | 2–4 vCPU, 8 GB RAM | 2–4 workers: 8 vCPU, 16 GB RAM each | 200 GB SSD/object storage | Engineering validation and limited parameter sweeps |
| Production | 20–100 | 4–8 vCPU, 16 GB RAM, 2 replicas | 4–16 workers: 8–16 vCPU, 32–64 GB RAM each | 1 TB+ object storage, lifecycle rules | Multi-project SOH, dispatch, warranty studies |

GPU is not required for standard PyBaMM solvers. Add GPU nodes only for validated neural surrogate models or accelerated calibration workloads. Prefer higher CPU clock, sufficient memory, and fast local scratch SSD for numerical runs.

## Capacity guardrails

- Default to one numerical job per worker process and cap solver memory.
- Separate quick engineering models from high-fidelity electrochemical jobs with different queues.
- Enforce per-user concurrency and total CPU-hour quotas.
- Persist heartbeat, attempt count, checkpoint URI, model version, input-data version, and error details.
- Store standard-study bundles outside the web process. The V0.2 local adapter uses four small JSON
  files per study plus SQLite metadata; capacity is driven mainly by retained source test data and
  future PyBaMM traces, not by the annual SOH summary bundle.
- Retain structured summaries in the database and large traces/reports in object storage.
- Alert when queue wait exceeds 10 minutes, worker heartbeat exceeds 60 seconds, or disk usage exceeds 75%.

## Availability and recovery

Use at-least-once job delivery with idempotent job identifiers. A worker lease expires when its heartbeat stops, after which another worker can resume or retry. Back up job metadata daily and version result artifacts. Commercial warranty runs should retain an immutable audit bundle containing inputs, model code revision, parameter-set revision, environment, logs, and output checksums.
