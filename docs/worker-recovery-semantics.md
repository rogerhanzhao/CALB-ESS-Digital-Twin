# Worker recovery semantics

This decision separates two kinds of durable state before the evidence-producing jobs are
ported from PR #41.

- A numerical simulation may use `ExecutionContext.resume_from` and `save_checkpoint` for
  solver state or completed time slices. A successful completion clears that checkpoint.
- Comparison, dataset-revision, calibration-fit, and standard-study jobs produce small,
  immutable bundles. Their first implementation restarts the deterministic operation after a
  lease loss and verifies/reuses a complete existing bundle; it does not resume inside a
  partially written bundle.
- A result and all artifact registrations become visible in one database transaction. A worker
  that lost its lease cannot register evidence or complete the job.
- Checkpoint files and partially written bundle files are not evidence. Only files whose size and
  SHA-256 digest are included in a successfully registered final result are publishable.

This keeps checkpoint/resume independent from artifact publication and gives each later job-type
PR one stable integration point: `ExecutionOutcome`.
