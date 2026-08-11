"""Export stable JSON Schemas for control-plane type generation."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from calb_ess_digital_twin.standard_study import StandardStudyRequest
from contracts.models import JobPayload, RunResult


def _ts_type(schema: dict[str, Any]) -> str:
    if "$ref" in schema:
        return schema["$ref"].rsplit("/", 1)[-1]
    if "enum" in schema:
        return " | ".join(json.dumps(value) for value in schema["enum"])
    if "anyOf" in schema:
        return " | ".join(dict.fromkeys(_ts_type(item) for item in schema["anyOf"]))
    kind = schema.get("type")
    if kind == "string":
        return "string"
    if kind in {"number", "integer"}:
        return "number"
    if kind == "boolean":
        return "boolean"
    if kind == "null":
        return "null"
    if kind == "array":
        return f"Array<{_ts_type(schema['items'])}>"
    if kind == "object":
        additional = schema.get("additionalProperties")
        if isinstance(additional, dict):
            return f"Record<string, {_ts_type(additional)}>"
        return "Record<string, unknown>"
    raise ValueError(f"unsupported JSON Schema node: {schema}")


def _typescript(models: list[type[JobPayload | RunResult]]) -> str:
    definitions: dict[str, dict[str, Any]] = {}
    roots: list[tuple[str, dict[str, Any]]] = []
    for model in models:
        schema = model.model_json_schema()
        definitions.update(schema.get("$defs", {}))
        roots.append((model.__name__, schema))

    ordered = ["ScenarioInput", "JobPayload", "ResultPoint", "Uncertainty", "RunResult"]
    roots_by_name = dict(roots)
    blocks = ["// Generated from contracts/models.py. Do not edit by hand.\n"]
    for name in ordered:
        schema = roots_by_name.get(name, definitions.get(name))
        if schema is None:
            continue
        required = set(schema.get("required", []))
        lines = [f"export interface {name} {{"]
        for field, node in schema.get("properties", {}).items():
            optional = "" if field in required else "?"
            lines.append(f"  {field}{optional}: {_ts_type(node)};")
        lines.append("}")
        blocks.append("\n".join(lines) + "\n")
    return "\n".join(blocks)


def export(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    schemas = {
        "job.schema.json": JobPayload,
        "result.schema.json": RunResult,
        "standard-study-request.schema.json": StandardStudyRequest,
    }
    for filename, model in schemas.items():
        content = json.dumps(model.model_json_schema(), indent=2, sort_keys=True) + "\n"
        (output_dir / filename).write_text(content, encoding="utf-8", newline="\n")
    (output_dir / "contracts.ts").write_text(
        _typescript([JobPayload, RunResult]), encoding="utf-8", newline="\n"
    )


if __name__ == "__main__":
    export(Path(__file__).with_name("generated"))
