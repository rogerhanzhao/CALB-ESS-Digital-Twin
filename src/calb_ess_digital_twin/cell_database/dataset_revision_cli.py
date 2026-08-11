"""CLI for the immutable dataset-revision evidence bundle."""

from __future__ import annotations

import argparse
from pathlib import Path

from .dataset_revision import DatasetRevisionRequest, write_dataset_revision_bundle


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate immutable CSV evidence and publish a dataset revision bundle."
    )
    parser.add_argument("source_csv", type=Path)
    parser.add_argument("request_json", type=Path)
    parser.add_argument("output_directory", type=Path)
    args = parser.parse_args()
    request = DatasetRevisionRequest.model_validate_json(
        args.request_json.read_text(encoding="utf-8")
    )
    result, _manifest = write_dataset_revision_bundle(
        args.source_csv, request, args.output_directory
    )
    print(f"Validation outcome: {result.validation_outcome}")
    print(f"Bundle: {args.output_directory}")
    return 2 if result.validation_outcome == "reject" else 0


if __name__ == "__main__":
    raise SystemExit(main())
