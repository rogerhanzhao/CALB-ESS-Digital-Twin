"""Like-for-like comparison of two immutable standard study result versions."""

from __future__ import annotations

import math
from datetime import date
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .standard_study import (
    StandardStudyArtifact,
    StandardStudyManifest,
    StandardStudyRequest,
)


class CapacityDirection(StrEnum):
    IMPROVED = "improved"
    DEGRADED = "degraded"
    UNCHANGED = "unchanged"


class TrustTransition(StrEnum):
    STAYED_VALID = "stayed_valid"
    STAYED_INVALID = "stayed_invalid"
    BECAME_VALID = "became_valid"
    BECAME_INVALID = "became_invalid"


class StudyVersionEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request: StandardStudyRequest
    artifact: StandardStudyArtifact
    manifest: StandardStudyManifest

    @model_validator(mode="after")
    def manifest_matches_artifact(self) -> StudyVersionEvidence:
        pairs = (
            (self.manifest.study_version, self.artifact.study_version, "study_version"),
            (self.manifest.result_version, self.artifact.result_version, "result_version"),
            (
                self.manifest.standard_scenario_version,
                self.artifact.exposure.standard_scenario_version,
                "standard_scenario_version",
            ),
            (
                self.manifest.calibration_id,
                self.artifact.soh_result.calibration_id,
                "calibration_id",
            ),
            (
                self.manifest.calibration_model_version,
                self.artifact.soh_result.calibration_model_version,
                "calibration_model_version",
            ),
            (
                self.manifest.calibration_approval_status,
                self.artifact.soh_result.calibration_approval_status,
                "calibration_approval_status",
            ),
            (
                self.manifest.engineering_review_eligible,
                self.artifact.soh_result.engineering_review_eligible,
                "engineering_review_eligible",
            ),
            (
                self.manifest.warranty_eligible,
                self.artifact.soh_result.warranty_eligible,
                "warranty_eligible",
            ),
        )
        for manifest_value, artifact_value, field in pairs:
            if manifest_value != artifact_value:
                raise ValueError(f"manifest {field} does not match study artifact")
        request_pairs = (
            (self.request.study_version, self.artifact.study_version, "study_version"),
            (self.request.result_version, self.artifact.result_version, "result_version"),
            (
                self.request.exposure_plan.standard_scenario_version,
                self.artifact.exposure.standard_scenario_version,
                "standard_scenario_version",
            ),
            (
                self.request.calibration.calibration_id,
                self.manifest.calibration_id,
                "calibration_id",
            ),
            (
                self.request.calibration.model_version,
                self.manifest.calibration_model_version,
                "calibration_model_version",
            ),
            (
                self.request.calibration.dataset_revision_ids,
                self.manifest.calibration_dataset_revision_ids,
                "calibration_dataset_revision_ids",
            ),
            (
                self.request.calibration.code_revision,
                self.manifest.calibration_code_revision,
                "calibration_code_revision",
            ),
            (
                self.request.calibration_approval_status,
                self.manifest.calibration_approval_status,
                "calibration_approval_status",
            ),
        )
        for request_value, evidence_value, field in request_pairs:
            if request_value != evidence_value:
                raise ValueError(f"request {field} does not match study evidence")
        if self.request.exposure_plan != self.artifact.exposure.plan:
            raise ValueError("request exposure plan does not match exposure artifact")
        if self.manifest.scenario_code_revision != self.request.exposure_plan.code_revision:
            raise ValueError("manifest scenario_code_revision does not match study request")
        if self.request.calibration.product_revision != self.artifact.exposure.product_revision:
            raise ValueError("calibration product revision does not match exposure artifact")
        if self.artifact.exposure.conditions != self.artifact.soh_result.conditions:
            raise ValueError("exposure conditions do not match SOH result conditions")
        exposure_points = self.artifact.exposure.exposure_points
        result_points = self.artifact.soh_result.points
        if len(exposure_points) != len(result_points):
            raise ValueError("exposure and SOH result point counts do not match")
        for exposure, result in zip(exposure_points, result_points):
            for field in (
                "year",
                "calendar_date",
                "elapsed_days",
                "absolute_throughput_ah",
                "cycle_count",
                "equivalent_full_cycles",
            ):
                if getattr(exposure, field) != getattr(result, field):
                    raise ValueError(f"exposure and SOH result {field} do not match")
        return self


class StudyComparisonPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    capacity_delta_tolerance_fraction: float = Field(ge=0)
    elapsed_days_tolerance: float = Field(ge=0)
    absolute_throughput_ah_tolerance: float = Field(ge=0)
    cycle_count_tolerance: float = Field(ge=0)
    equivalent_full_cycles_tolerance: float = Field(ge=0)


class StudyComparisonConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    schema_version: Literal["V0.2"] = "V0.2"
    comparison_version: str = Field(min_length=1)
    policy: StudyComparisonPolicy


class StudyComparisonRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["V0.2"] = "V0.2"
    comparison_version: str = Field(min_length=1)
    baseline: StudyVersionEvidence
    current: StudyVersionEvidence
    policy: StudyComparisonPolicy

    @model_validator(mode="after")
    def studies_are_like_for_like(self) -> StudyComparisonRequest:
        baseline = self.baseline.artifact
        current = self.current.artifact
        if baseline.study_version == current.study_version:
            raise ValueError("baseline and current study_version must differ")
        if baseline.result_version == current.result_version:
            raise ValueError("baseline and current result_version must differ")
        if baseline.exposure.product_revision != current.exposure.product_revision:
            raise ValueError("product revision differs; comparison is not like-for-like")
        if (
            baseline.exposure.standard_scenario_version
            != current.exposure.standard_scenario_version
        ):
            raise ValueError("standard scenario version differs; comparison is not like-for-like")
        if baseline.exposure.conditions != current.exposure.conditions:
            raise ValueError("standard scenario conditions differ; comparison is not like-for-like")
        baseline_points = baseline.soh_result.points
        current_points = current.soh_result.points
        if len(baseline_points) != len(current_points):
            raise ValueError("trajectory point counts differ; comparison is not like-for-like")
        for old, new in zip(baseline_points, current_points):
            if old.year != new.year or old.calendar_date != new.calendar_date:
                raise ValueError("trajectory calendar axes differ; comparison is not like-for-like")
            for field in (
                "elapsed_days",
                "absolute_throughput_ah",
                "cycle_count",
                "equivalent_full_cycles",
            ):
                tolerance = {
                    "elapsed_days": self.policy.elapsed_days_tolerance,
                    "absolute_throughput_ah": (
                        self.policy.absolute_throughput_ah_tolerance
                    ),
                    "cycle_count": self.policy.cycle_count_tolerance,
                    "equivalent_full_cycles": (
                        self.policy.equivalent_full_cycles_tolerance
                    ),
                }[field]
                if not math.isclose(
                    getattr(old, field),
                    getattr(new, field),
                    rel_tol=0,
                    abs_tol=tolerance,
                ):
                    raise ValueError(
                        f"trajectory {field} differs at year {old.year}; comparison is not like-for-like"
                    )
        return self


class StudyPointComparison(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    year: int
    calendar_date: date
    baseline_capacity_fraction: float
    current_capacity_fraction: float
    capacity_delta_fraction: float
    capacity_direction: CapacityDirection
    validity_transition: TrustTransition
    physical_transition: TrustTransition
    added_issues: tuple[str, ...]
    removed_issues: tuple[str, ...]


class StudyComparisonResult(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    schema_version: Literal["V0.2"] = "V0.2"
    comparison_version: str
    product_revision: str
    standard_scenario_version: str
    baseline_study_version: str
    current_study_version: str
    baseline_result_version: str
    current_result_version: str
    baseline_calibration_id: str
    current_calibration_id: str
    baseline_dataset_revision_ids: tuple[str, ...]
    current_dataset_revision_ids: tuple[str, ...]
    calibration_evidence_changed: bool
    scenario_code_revision_changed: bool
    comparison_is_like_for_like: Literal[True] = True
    capacity_delta_tolerance_fraction: float
    maximum_absolute_capacity_delta_fraction: float
    final_capacity_delta_fraction: float
    improved_point_count: int
    degraded_point_count: int
    unchanged_point_count: int
    validity_changed_years: tuple[int, ...]
    physical_validity_changed_years: tuple[int, ...]
    engineering_review_eligibility_changed: bool
    points: list[StudyPointComparison]


def compare_standard_studies(request: StudyComparisonRequest) -> StudyComparisonResult:
    """Compare capacity and trust state after the request proves exposure equivalence."""

    baseline = request.baseline
    current = request.current
    points: list[StudyPointComparison] = []
    for old, new in zip(
        baseline.artifact.soh_result.points, current.artifact.soh_result.points
    ):
        delta = new.predicted_capacity_fraction - old.predicted_capacity_fraction
        direction = _direction(delta, request.policy.capacity_delta_tolerance_fraction)
        old_issues = {str(item) for item in old.issues}
        new_issues = {str(item) for item in new.issues}
        points.append(
            StudyPointComparison(
                year=old.year,
                calendar_date=old.calendar_date,
                baseline_capacity_fraction=old.predicted_capacity_fraction,
                current_capacity_fraction=new.predicted_capacity_fraction,
                capacity_delta_fraction=delta,
                capacity_direction=direction,
                validity_transition=_transition(
                    old.within_validity_envelope, new.within_validity_envelope
                ),
                physical_transition=_transition(
                    old.physically_valid_prediction, new.physically_valid_prediction
                ),
                added_issues=tuple(sorted(new_issues - old_issues)),
                removed_issues=tuple(sorted(old_issues - new_issues)),
            )
        )

    directions = [point.capacity_direction for point in points]
    deltas = [point.capacity_delta_fraction for point in points]
    baseline_manifest = baseline.manifest
    current_manifest = current.manifest
    calibration_changed = (
        baseline_manifest.calibration_id != current_manifest.calibration_id
        or baseline_manifest.calibration_model_version
        != current_manifest.calibration_model_version
        or baseline_manifest.calibration_code_revision
        != current_manifest.calibration_code_revision
        or baseline_manifest.calibration_dataset_revision_ids
        != current_manifest.calibration_dataset_revision_ids
    )
    return StudyComparisonResult(
        comparison_version=request.comparison_version,
        product_revision=baseline.artifact.exposure.product_revision,
        standard_scenario_version=baseline_manifest.standard_scenario_version,
        baseline_study_version=baseline_manifest.study_version,
        current_study_version=current_manifest.study_version,
        baseline_result_version=baseline_manifest.result_version,
        current_result_version=current_manifest.result_version,
        baseline_calibration_id=baseline_manifest.calibration_id,
        current_calibration_id=current_manifest.calibration_id,
        baseline_dataset_revision_ids=baseline_manifest.calibration_dataset_revision_ids,
        current_dataset_revision_ids=current_manifest.calibration_dataset_revision_ids,
        calibration_evidence_changed=calibration_changed,
        scenario_code_revision_changed=(
            baseline_manifest.scenario_code_revision
            != current_manifest.scenario_code_revision
        ),
        capacity_delta_tolerance_fraction=(
            request.policy.capacity_delta_tolerance_fraction
        ),
        maximum_absolute_capacity_delta_fraction=max(abs(delta) for delta in deltas),
        final_capacity_delta_fraction=deltas[-1],
        improved_point_count=directions.count(CapacityDirection.IMPROVED),
        degraded_point_count=directions.count(CapacityDirection.DEGRADED),
        unchanged_point_count=directions.count(CapacityDirection.UNCHANGED),
        validity_changed_years=tuple(
            point.year
            for point in points
            if point.validity_transition
            in (TrustTransition.BECAME_VALID, TrustTransition.BECAME_INVALID)
        ),
        physical_validity_changed_years=tuple(
            point.year
            for point in points
            if point.physical_transition
            in (TrustTransition.BECAME_VALID, TrustTransition.BECAME_INVALID)
        ),
        engineering_review_eligibility_changed=(
            baseline_manifest.engineering_review_eligible
            != current_manifest.engineering_review_eligible
        ),
        points=points,
    )


def _direction(delta: float, tolerance: float) -> CapacityDirection:
    if delta > tolerance:
        return CapacityDirection.IMPROVED
    if delta < -tolerance:
        return CapacityDirection.DEGRADED
    return CapacityDirection.UNCHANGED


def _transition(old: bool, new: bool) -> TrustTransition:
    if old and new:
        return TrustTransition.STAYED_VALID
    if not old and not new:
        return TrustTransition.STAYED_INVALID
    return TrustTransition.BECAME_VALID if new else TrustTransition.BECAME_INVALID
