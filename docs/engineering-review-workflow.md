# Engineering review workflow

The V0.2 engineering review is a human decision over one exact completed standard-study evidence
set. It is not an execution status and it is not a commercial warranty approval.

## Evidence gate

A reviewer may record `approved` only when the owned run:

- was executed by the `standard-study` engine and is completed;
- has a positive run-level validity-envelope verdict;
- retains checksum-addressed `manifest.json` and `soh-result.json` objects;
- passes a fresh byte-count and SHA-256 check when the decision is written;
- has matching result and calibration identities across both artifacts;
- reports every trajectory point inside the approved envelope and physically valid; and
- is marked engineering-review eligible while both artifacts still state
  `warranty_eligible = false`.

`changes_requested` and `rejected` remain available for a completed result that does not pass
those eligibility gates, so the reviewer can record why it cannot proceed.

## Append-only history

Every decision creates a new `engineering_reviews` row. Existing decisions are never overwritten.
The row records the authenticated reviewer, comment, time, and the manifest and SOH-result
checksums that were examined. An idempotency key prevents a retried browser request from creating
a duplicate decision.

The latest decision is the current engineering-review state, while the full sequence remains
visible for audit. A later approval does not erase an earlier request for changes.

## Warranty boundary

Engineering approval means the cell-level reduced-order result may proceed to system-level
analysis. It does not make the trajectory a warranty curve. Warranty eligibility remains blocked
until the platform has quantified uncertainty and completed cell-to-system translation for pack
integration losses, usable SOC window, auxiliary load, availability, dispersion, RTE degradation,
and augmentation policy.

Concept & System Design · Alex.Z
