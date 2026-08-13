"""Command-line entry point for creating test-data validation artifacts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, model_validator

from .cycle_metrics import CycleMetricPolicy, derive_cycle_metrics
from .import_validation import (
    ColumnMapping,
    ImportManifest,
    TestType,
    ValidationLevel,
    ValidationPolicy,
    validate_csv_import,
)


class ImportConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    manifest: ImportManifest
    mappings: list[ColumnMapping]
    policy: ValidationPolicy
    cycle_metric_policy: CycleMetricPolicy | None = None

    @model_validator(mode="after")
    def cycle_metrics_only_apply_to_cycle_aging(self) -> ImportConfiguration:
        if (
            self.cycle_metric_policy is not None
            and self.manifest.test_type != TestType.CYCLE_AGING
        ):
            raise ValueError("cycle_metric_policy is only valid for cycle_aging imports")
        return self


def load_configuration(path: Path) -> ImportConfiguration:
    with path.open("r", encoding="utf-8") as source:
        raw: Any = yaml.safe_load(source)
    return ImportConfiguration.model_validate(raw)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate a measured cell-test CSV and emit immutable revision artifacts."
    )
    parser.add_argument("source_csv", type=Path)
    parser.add_argument("configuration", type=Path)
    parser.add_argument("output_directory", type=Path)
    args = parser.parse_args()

    if args.output_directory.exists():
        parser.error("output_directory already exists; dataset revisions must not be overwritten")

    configuration = load_configuration(args.configuration)
    imported = validate_csv_import(
        args.source_csv,
        configuration.manifest,
        configuration.mappings,
        configuration.policy,
    )

    cycle_report = None
    if imported.normalized is not None and configuration.cycle_metric_policy is not None:
        cycle_report = derive_cycle_metrics(imported.normalized, configuration.cycle_metric_policy)

    args.output_directory.mkdir(parents=True)
    report_path = args.output_directory / "validation-report.json"
    report_path.write_text(
        json.dumps(imported.report.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    if imported.normalized is not None:
        imported.normalized.to_csv(args.output_directory / "canonical.csv", index=False)
        if cycle_report is not None:
            (args.output_directory / "cycle-metrics.json").write_text(
                json.dumps(cycle_report.model_dump(mode="json"), indent=2) + "\n",
                encoding="utf-8",
            )

    print(f"Validation outcome: {imported.report.outcome}")
    print(f"Report: {report_path}")
    return 2 if imported.report.outcome == ValidationLevel.REJECT else 0


if __name__ == "__main__":
    raise SystemExit(main())
