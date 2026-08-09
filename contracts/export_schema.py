"""Export stable JSON Schemas for control-plane type generation."""

from __future__ import annotations

import json
from pathlib import Path

from contracts.models import JobPayload, RunResult


def export(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    schemas = {"job.schema.json": JobPayload, "result.schema.json": RunResult}
    for filename, model in schemas.items():
        content = json.dumps(model.model_json_schema(), indent=2, sort_keys=True) + "\n"
        (output_dir / filename).write_text(content, encoding="utf-8")


if __name__ == "__main__":
    export(Path(__file__).with_name("generated"))
