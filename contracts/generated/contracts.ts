// Generated from contracts/models.py. Do not edit by hand.

export interface ScenarioInput {
  name: string;
  chemistry?: string;
  cell_param_set_version?: string | null;
  horizon_years: number;
  cycles_per_day: number;
  depth_of_discharge: number;
  soc_window_min: number;
  soc_window_max: number;
  ambient_temperature_c: number;
  initial_soc: number;
  end_of_life_fraction: number;
}

export interface JobPayload {
  contract_version?: string;
  job_id: string;
  scenario_id: string;
  user_id: string;
  engine: "demo" | "stub" | "pybamm-spme" | "semi-empirical" | "standard-study";
  model_version: string;
  code_revision: string;
  scenario?: ScenarioInput | null;
  standard_study_request?: Record<string, unknown> | null;
  submitted_at?: string;
}

export interface ResultPoint {
  year: number;
  soh: number;
  resistance_growth: number;
  cumulative_throughput_mwh: number;
}

export interface Uncertainty {
  confidence_level: number;
  source: "parameter_uncertainty" | "sample_variance" | "monte_carlo" | "extrapolation_error" | "combined" | "not_available";
  lower_soh?: number | null;
  upper_soh?: number | null;
}

export interface RunResult {
  contract_version?: string;
  job_id: string;
  engine: "demo" | "stub" | "pybamm-spme" | "semi-empirical" | "standard-study";
  model_version: string;
  code_revision: string;
  status: "completed" | "failed" | "cancelled";
  points?: Array<ResultPoint>;
  end_soh?: number | null;
  within_validity_envelope?: boolean | null;
  uncertainty: Uncertainty;
  metrics?: Record<string, number>;
  warnings?: Array<string>;
  artifact_checksums?: Record<string, string>;
  completed_at?: string;
}
