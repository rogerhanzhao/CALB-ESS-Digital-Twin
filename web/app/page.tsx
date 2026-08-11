"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Simulation = {
  id: string;
  scenarioId: string;
  name: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  chemistry: string;
  horizonYears: number;
  cyclesPerDay: number;
  endSoh: number | null;
  modelVersion: string | null;
  codeRevision: string | null;
  engine: "demo" | "stub" | "pybamm-spme" | "semi-empirical" | "standard-study" | "unrecognized";
  withinValidityEnvelope: boolean | null;
  createdAt: string;
  demo: boolean;
};

type RunArtifact = {
  kind: string;
  contentType: string | null;
  sizeBytes: number | null;
  checksum: string | null;
  createdAt: string;
  href: string;
};
type RunDetail = {
  runId: string;
  provenance: {
    jobContractVersion: string | null;
    payloadChecksumSha256: string | null;
    workerId: string | null;
    attempt: number;
    withinValidityEnvelope: boolean | null;
    error: string | null;
  };
  artifacts: RunArtifact[];
};
type SohResult = {
  runId: string;
  result_version: string;
  engineering_review_eligible: boolean;
  warranty_eligible: false;
  uncertainty_status: string;
  warnings: string[];
  points: Array<{
    year: number;
    predicted_capacity_fraction: number;
    equivalent_full_cycles: number;
    absolute_throughput_ah: number;
    within_validity_envelope: boolean;
  }>;
};
type EngineeringReview = {
  id: string;
  runId: string;
  decision: "approved" | "changes_requested" | "rejected";
  comment: string;
  reviewerEmail: string | null;
  manifestChecksumSha256: string;
  sohResultChecksumSha256: string;
  createdAt: string;
};
type StudyComparison = {
  id: string;
  baselineRunId: string;
  currentRunId: string;
  comparisonVersion: string;
  codeRevision: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  attempt: number;
  error: string | null;
  finalCapacityDeltaFraction: number | null;
  maximumAbsoluteCapacityDeltaFraction: number | null;
  createdAt: string;
};

type ProductOption = { id: string; model: string; revision: string; status: string };
type CalibrationOption = {
  id: string;
  productId: string;
  artifactCalibrationId: string | null;
  modelVersion: string;
  status: string;
};
type StandardScenarioOption = {
  id: string;
  code: string;
  version: number;
  name: string;
  status: string;
};
type DatasetOption = { id: string; name: string; productId: string; testType: string; status: string; checksumSha256: string | null; byteCount: number | null; sourceHref: string };
type ValidationPolicyOption = { id: string; productId: string; version: string; status: "draft" | "approved" | "retired"; voltageMinV: number; voltageMaxV: number; absoluteCurrentMaxA: number; temperatureMinC: number; temperatureMaxC: number };
type DatasetRevisionOption = { id: string; datasetId: string; revision: string; processingStatus: "queued" | "running" | "completed" | "failed" | "cancelled"; validationStatus: "pending" | "pass" | "warning" | "reject"; rowCount: number | null; totalAbsoluteThroughputAh: number | null; totalEquivalentFullCycles: number | null; error: string | null };

type AuthState = "unknown" | "anonymous" | "authenticated";
type SectionId = "overview" | "products" | "test-data" | "models" | "runs" | "results" | "warranty";

/**
 * Local preview rows. These exist so the layout is inspectable without a database
 * binding; they are flagged `demo` exactly like server-side demonstrator rows so the
 * interface never presents them as real results.
 */
const previewRuns: Simulation[] = [
  { id: "preview-1", scenarioId: "preview-1", name: "314 Ah · 20 年基准工况", status: "running", progress: 68, chemistry: "LFP", horizonYears: 20, cyclesPerDay: 1, endSoh: null, modelVersion: null, codeRevision: null, engine: "demo", withinValidityEnvelope: null, createdAt: "2026-08-09T08:42:00Z", demo: true },
  { id: "preview-2", scenarioId: "preview-2", name: "AIDC 两充两放压力测试", status: "completed", progress: 100, chemistry: "LFP", horizonYears: 15, cyclesPerDay: 2, endSoh: 76.8, modelVersion: null, codeRevision: null, engine: "demo", withinValidityEnvelope: null, createdAt: "2026-08-08T03:12:00Z", demo: true },
  { id: "preview-3", scenarioId: "preview-3", name: "JP 项目质保边界", status: "completed", progress: 100, chemistry: "LFP", horizonYears: 20, cyclesPerDay: 1, endSoh: 81.4, modelVersion: null, codeRevision: null, engine: "demo", withinValidityEnvelope: null, createdAt: "2026-08-07T11:08:00Z", demo: true },
];

const statusLabel: Record<Simulation["status"], string> = {
  queued: "排队中",
  running: "计算中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const EM_DASH = "—";

export default function Home() {
  const [runs, setRuns] = useState<Simulation[]>(previewRuns);
  const [selected, setSelected] = useState(previewRuns[0].id);
  const [auth, setAuth] = useState<AuthState>("unknown");
  const [name, setName] = useState("314 Ah · 20 年基准工况");
  const [horizon, setHorizon] = useState(20);
  const [cycles, setCycles] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("本地预览数据");
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [productId, setProductId] = useState("");
  const [productModel, setProductModel] = useState("");
  const [capacityAh, setCapacityAh] = useState(314);
  const [revision, setRevision] = useState("R1");
  const [datasetFile, setDatasetFile] = useState<File | null>(null);
  const [datasetType, setDatasetType] = useState("cycle_aging");
  const [batchCode, setBatchCode] = useState("");
  const [sourceLab, setSourceLab] = useState("");
  const [sampleCode, setSampleCode] = useState("");
  const [equipmentId, setEquipmentId] = useState("");
  const [operator, setOperator] = useState("");
  const [testStartedAt, setTestStartedAt] = useState("");
  const [testEndedAt, setTestEndedAt] = useState("");
  const [unitSchema, setUnitSchema] = useState("canonical-csv-V0.2");
  const [submittingDataset, setSubmittingDataset] = useState(false);
  const [datasets, setDatasets] = useState<DatasetOption[]>([]);
  const [validationPolicies, setValidationPolicies] = useState<ValidationPolicyOption[]>([]);
  const [datasetRevisions, setDatasetRevisions] = useState<DatasetRevisionOption[]>([]);
  const [policyVersion, setPolicyVersion] = useState("policy-V1");
  const [policyBounds, setPolicyBounds] = useState({ voltageMinV: "", voltageMaxV: "", absoluteCurrentMaxA: "", temperatureMinC: "", temperatureMaxC: "" });
  const [selectedDataset, setSelectedDataset] = useState("");
  const [selectedValidationPolicy, setSelectedValidationPolicy] = useState("");
  const [datasetRevisionVersion, setDatasetRevisionVersion] = useState("R1");
  const [datasetRevisionCode, setDatasetRevisionCode] = useState("dataset-V1");
  const [mappingJson, setMappingJson] = useState('[{"source_column":"timestamp","canonical_column":"timestamp","source_unit":"iso8601"}]');
  const [cyclePolicyJson, setCyclePolicyJson] = useState('{"step_roles":{"1":"charge","2":"rest","3":"discharge","4":"rest"},"full_cycle_sequence":["charge","rest","discharge","rest"]}');
  const [submittingRevision, setSubmittingRevision] = useState(false);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [calibrations, setCalibrations] = useState<CalibrationOption[]>([]);
  const [standardScenarios, setStandardScenarios] = useState<StandardScenarioOption[]>([]);
  const [selectedCalibration, setSelectedCalibration] = useState("");
  const [selectedStandardScenario, setSelectedStandardScenario] = useState("");
  const [studyStartDate, setStudyStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [submittingStandardStudy, setSubmittingStandardStudy] = useState(false);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [sohResult, setSohResult] = useState<SohResult | null>(null);
  const [reviewState, setReviewState] = useState<{ runId: string; reviews: EngineeringReview[] } | null>(null);
  const [reviewDecision, setReviewDecision] = useState<EngineeringReview["decision"]>("approved");
  const [reviewComment, setReviewComment] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);
  const [comparisons, setComparisons] = useState<StudyComparison[]>([]);
  const [comparisonBaseline, setComparisonBaseline] = useState("");
  const [comparisonCurrent, setComparisonCurrent] = useState("");
  const [comparisonVersion, setComparisonVersion] = useState("V1");
  const [comparisonCodeRevision, setComparisonCodeRevision] = useState("compare-V1");
  const [submittingComparison, setSubmittingComparison] = useState(false);

  const navigateTo = (section: SectionId) => {
    setActiveSection(section);
    document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/simulations", { cache: "no-store" });
        if (!active) return;
        if (response.status === 401) {
          setAuth("anonymous");
          setNotice("未登录 · 当前显示本地预览数据");
          return;
        }
        if (!response.ok) return;
        const payload = (await response.json()) as { simulations: Simulation[] };
        if (!active) return;
        setAuth("authenticated");
        setRuns(payload.simulations);
        const comparisonCandidates = payload.simulations.filter((run) => !run.demo && run.engine === "standard-study" && run.status === "completed");
        setComparisonBaseline((value) => value || comparisonCandidates[0]?.id || "");
        setComparisonCurrent((value) => value || comparisonCandidates[1]?.id || "");
        setSelected((current) =>
          payload.simulations.some((run) => run.id === current)
            ? current
            : payload.simulations[0]?.id ?? current,
        );
        setNotice("任务已同步 · 关闭页面不会中断计算");
        const [productResponse, calibrationResponse, standardResponse, comparisonResponse, datasetResponse, policyResponse, revisionResponse] = await Promise.all([
          fetch("/api/products", { cache: "no-store" }),
          fetch("/api/calibrations", { cache: "no-store" }),
          fetch("/api/standard-scenarios", { cache: "no-store" }),
          fetch("/api/study-comparisons", { cache: "no-store" }),
          fetch("/api/test-datasets", { cache: "no-store" }),
          fetch("/api/dataset-validation-policies", { cache: "no-store" }),
          fetch("/api/dataset-revisions", { cache: "no-store" }),
        ]);
        if (productResponse.ok) {
          const data = await productResponse.json() as { products: ProductOption[] };
          setProducts(data.products);
        }
        if (calibrationResponse.ok) {
          const data = await calibrationResponse.json() as { calibrations: CalibrationOption[] };
          setCalibrations(data.calibrations);
          setSelectedCalibration((current) => current || data.calibrations.find((item) => item.status === "approved")?.id || "");
        }
        if (standardResponse.ok) {
          const data = await standardResponse.json() as { standardScenarios: StandardScenarioOption[] };
          setStandardScenarios(data.standardScenarios);
          setSelectedStandardScenario((current) => current || data.standardScenarios.find((item) => item.status === "released")?.id || "");
        }
        if (comparisonResponse.ok) {
          const data = await comparisonResponse.json() as { comparisons: StudyComparison[] };
          setComparisons(data.comparisons);
        }
        if (datasetResponse.ok) {
          const data = await datasetResponse.json() as { datasets: DatasetOption[] };
          setDatasets(data.datasets); setSelectedDataset((value) => value || data.datasets[0]?.id || "");
        }
        if (policyResponse.ok) {
          const data = await policyResponse.json() as { policies: ValidationPolicyOption[] };
          setValidationPolicies(data.policies); setSelectedValidationPolicy((value) => value || data.policies.find((item) => item.status === "approved")?.id || "");
        }
        if (revisionResponse.ok) {
          const data = await revisionResponse.json() as { revisions: DatasetRevisionOption[] };
          setDatasetRevisions(data.revisions);
        }
      } catch {
        // Network failure during local preview: keep the rows already on screen.
      }
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let active = true;
    if (auth !== "authenticated" || !selected) return () => { active = false; };
    const loadDetail = async () => {
      const response = await fetch(`/api/simulations/${encodeURIComponent(selected)}`, { cache: "no-store" });
      if (!response.ok || !active) return;
      const detail = await response.json() as RunDetail & { simulation: Simulation };
      setRunDetail({ ...detail, runId: selected });
      const reviewResponse = await fetch(`/api/simulations/${encodeURIComponent(selected)}/reviews`, { cache: "no-store" });
      if (reviewResponse.ok && active) {
        const reviewPayload = await reviewResponse.json() as { reviews: EngineeringReview[] };
        setReviewState({ runId: selected, reviews: reviewPayload.reviews });
      }
      const sohArtifact = detail.artifacts.find((artifact) => artifact.kind === "soh-result.json");
      if (!sohArtifact) return;
      const artifactResponse = await fetch(sohArtifact.href, { cache: "no-store" });
      if (!artifactResponse.ok || !active) return;
      const result = await artifactResponse.json() as Omit<SohResult, "runId">;
      setSohResult({ ...result, runId: selected });
    };
    loadDetail().catch(() => undefined);
    return () => { active = false; };
  }, [auth, selected]);

  const current = useMemo(
    () => runs.find((run) => run.id === selected) ?? runs[0],
    [runs, selected],
  );
  const currentDetail = runDetail?.runId === current?.id ? runDetail : null;
  const currentSohResult = sohResult?.runId === current?.id ? sohResult : null;
  const currentReviews = reviewState?.runId === current?.id ? reviewState.reviews : [];
  const latestReview = currentReviews.at(-1);
  const activeCount = runs.filter((run) => run.status === "running" || run.status === "queued").length;
  const completedCount = runs.filter((run) => run.status === "completed").length;
  /** Every run is demonstrator output until a compute worker is connected. */
  const anyDemo = runs.some((run) => run.demo);
  const comparableRuns = runs.filter((run) => !run.demo && run.engine === "standard-study" && run.status === "completed");

  async function submitComparison(event: FormEvent) {
    event.preventDefault();
    setSubmittingComparison(true);
    try {
      const response = await fetch("/api/study-comparisons", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          baselineRunId: comparisonBaseline,
          currentRunId: comparisonCurrent,
          comparisonVersion,
          codeRevision: comparisonCodeRevision,
          policy: {
            capacity_fraction_tolerance: 0.000001,
            elapsed_days_tolerance: 0.001,
            absolute_throughput_ah_tolerance: 0.001,
            cycle_count_tolerance: 0.001,
            equivalent_full_cycles_tolerance: 0.001,
          },
        }),
      });
      const payload = await response.json() as { comparison?: StudyComparison; error?: string; details?: string[] };
      if (!response.ok || !payload.comparison) {
        throw new Error(payload.details?.join("；") || payload.error || "对比任务提交失败");
      }
      setComparisons((items) => [payload.comparison!, ...items.filter((item) => item.id !== payload.comparison!.id)]);
      setNotice("对比任务已进入独立计算队列 · 关闭页面不会中断");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "对比任务提交失败");
    } finally {
      setSubmittingComparison(false);
    }
  }

  async function submitRun(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await fetch("/api/simulations", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ name, horizonYears: horizon, cyclesPerDay: cycles, chemistry: "LFP" }),
      });
      if (response.status === 401) throw new Error("请先登录后再提交任务");
      const payload = (await response.json()) as
        | { simulation: Simulation }
        | { error: string; details?: string[] };
      if (!response.ok) {
        const detail = "details" in payload && payload.details?.length ? payload.details.join("；") : null;
        throw new Error(detail ?? ("error" in payload ? payload.error : "任务提交失败"));
      }
      const simulation = (payload as { simulation: Simulation }).simulation;
      setRuns((items) => [simulation, ...items.filter((item) => item.id !== simulation.id)]);
      setSelected(simulation.id);
      setNotice("任务已提交到持久队列，可安全关闭页面");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "任务提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveProduct(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/products", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manufacturer: "CALB", model: productModel, chemistry: "LFP", nominalCapacityAh: capacityAh, nominalVoltageV: 3.2, revision }) });
    const payload = await response.json() as { product?: { id: string }; error?: string; details?: string[] };
    if (!response.ok) { setNotice(response.status === 401 ? "请先登录后保存产品档案" : payload.details?.join("；") ?? payload.error ?? "保存失败"); return; }
    setProductId(payload.product?.id ?? "");
    setNotice("产品草稿已保存，可继续登记测试数据");
  }

  async function registerDataset(event: FormEvent) {
    event.preventDefault();
    if (!datasetFile || !productId) { setNotice("请先保存产品档案并选择测试文件"); return; }
    if (!testStartedAt || !testEndedAt || new Date(testEndedAt) <= new Date(testStartedAt)) { setNotice("请填写真实测试起止时间，且结束时间必须晚于开始时间"); return; }
    setSubmittingDataset(true);
    try {
      const form = new FormData();
      for (const [key, value] of Object.entries({ productId, sampleCode, name: datasetFile.name, testType: datasetType, batchCode, sourceLab, equipmentId, operator, testStartedAt: new Date(testStartedAt).toISOString(), testEndedAt: new Date(testEndedAt).toISOString(), unitSchema })) form.set(key, value);
      form.set("sourceFile", datasetFile);
      const response = await fetch("/api/test-datasets", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: form });
      const payload = await response.json() as { dataset?: DatasetOption & { rowCount: number | null }; error?: string; details?: string[] };
      if (!response.ok || !payload.dataset) { setNotice(payload.details?.join("；") ?? payload.error ?? "上传失败"); return; }
      setNotice(`原始测试证据已不可变保存 · ${payload.dataset.byteCount} B · SHA-256 ${payload.dataset.checksumSha256?.slice(0, 12) ?? "待核验"} · ${payload.dataset.rowCount ?? "待解析"} 行`);
      setDatasets((items) => [payload.dataset!, ...items]); setSelectedDataset(payload.dataset.id);
      setDatasetFile(null);
    } finally {
      setSubmittingDataset(false);
    }
  }

  async function createValidationPolicy(event: FormEvent) {
    event.preventDefault();
    if (!productId) { setNotice("请先保存产品档案"); return; }
    const numbers = Object.fromEntries(Object.entries(policyBounds).map(([key, value]) => [key, Number(value)]));
    const response = await fetch("/api/dataset-validation-policies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId, version: policyVersion, ...numbers, irregularIntervalFraction: 0.1, gapIntervalMultiplier: 3 }) });
    const payload = await response.json() as { policy?: ValidationPolicyOption; error?: string; details?: string[] };
    if (!response.ok || !payload.policy) { setNotice(payload.details?.join("；") ?? payload.error ?? "策略保存失败"); return; }
    setValidationPolicies((items) => [payload.policy!, ...items]); setNotice("验证策略草稿已保存；确认边界来自正式产品/试验计划后再批准");
  }

  async function approveValidationPolicy(id: string) {
    const response = await fetch(`/api/dataset-validation-policies/${encodeURIComponent(id)}/approve`, { method: "POST" });
    const payload = await response.json() as { policy?: ValidationPolicyOption; error?: string };
    if (!response.ok || !payload.policy) { setNotice(payload.error ?? "策略批准失败"); return; }
    setValidationPolicies((items) => items.map((item) => item.id === id ? payload.policy! : item));
    setSelectedValidationPolicy(id); setNotice("验证策略已冻结批准，可用于数据修订");
  }

  async function submitDatasetRevision(event: FormEvent) {
    event.preventDefault(); setSubmittingRevision(true);
    try {
      const dataset = datasets.find((item) => item.id === selectedDataset);
      const mappings = JSON.parse(mappingJson);
      const cycleMetricPolicy = dataset?.testType === "cycle_aging" ? JSON.parse(cyclePolicyJson) : null;
      const response = await fetch("/api/dataset-revisions", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ datasetId: selectedDataset, validationPolicyId: selectedValidationPolicy, revision: datasetRevisionVersion, mappingVersion: "mapping-V1", cleaningRuleVersion: "cleaning-V1", codeRevision: datasetRevisionCode, currentSign: "charge_positive", mappings, cycleMetricPolicy }) });
      const payload = await response.json() as { revision?: DatasetRevisionOption; error?: string; details?: string[] };
      if (!response.ok || !payload.revision) { setNotice(payload.details?.join("；") ?? payload.error ?? "数据修订提交失败"); return; }
      setDatasetRevisions((items) => [payload.revision!, ...items]); setNotice("数据修订已进入独立 Python 计算队列 · 关闭页面不会中断");
    } catch (error) { setNotice(error instanceof Error ? `映射/步骤 JSON 无效：${error.message}` : "数据修订提交失败"); }
    finally { setSubmittingRevision(false); }
  }

  async function submitStandardStudy(event: FormEvent) {
    event.preventDefault();
    if (!selectedStandardScenario || !selectedCalibration) {
      setNotice("需要先选择已发布标准工况与已批准校准");
      return;
    }
    setSubmittingStandardStudy(true);
    try {
      const response = await fetch("/api/standard-studies", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          standardScenarioId: selectedStandardScenario,
          calibrationId: selectedCalibration,
          studyStartDate,
        }),
      });
      const payload = await response.json() as { simulation?: Simulation; error?: string; details?: string[] };
      if (!response.ok || !payload.simulation) {
        throw new Error(payload.details?.join("；") ?? payload.error ?? "标准研究提交失败");
      }
      setRuns((items) => [payload.simulation!, ...items.filter((item) => item.id !== payload.simulation!.id)]);
      setSelected(payload.simulation.id);
      setNotice("真实标准研究已写入持久队列，等待 Python Worker 领取");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "标准研究提交失败");
    } finally {
      setSubmittingStandardStudy(false);
    }
  }

  async function submitEngineeringReview(event: FormEvent) {
    event.preventDefault();
    if (!current || current.demo) return;
    setSubmittingReview(true);
    try {
      const response = await fetch(`/api/simulations/${encodeURIComponent(current.id)}/reviews`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ decision: reviewDecision, comment: reviewComment }),
      });
      const payload = await response.json() as { review?: EngineeringReview; error?: string; details?: string[] };
      if (!response.ok || !payload.review) {
        throw new Error(payload.details?.join("；") ?? payload.error ?? "审核记录保存失败");
      }
      setReviewState((state) => ({
        runId: current.id,
        reviews: state?.runId === current.id ? [...state.reviews, payload.review!] : [payload.review!],
      }));
      setReviewComment("");
      setNotice("工程审核决定已绑定到当前结果证据");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "审核记录保存失败");
    } finally {
      setSubmittingReview(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><i /><i /><i /></span><div><strong>ESS Digital Twin</strong><small>CALB · ENGINEERING PLATFORM</small></div></div>
        <nav aria-label="主导航">
          {([
            ["overview", "⌁", "项目总览"], ["products", "▣", "产品与方案"],
            ["test-data", "⇧", "测试数据"], ["models", "◇", "模型与标定"],
            ["runs", "◫", "仿真任务"], ["results", "⌁", "结果与版本"],
            ["warranty", "◎", "审核与质保"],
          ] as const).map(([id, icon, label]) => (
            <a key={id} href={`#${id}`} aria-current={activeSection === id ? "page" : undefined} className={`nav-item ${activeSection === id ? "active" : ""}`} onClick={() => setActiveSection(id)}><span>{icon}</span>{label}</a>
          ))}
        </nav>
        <div className="sidebar-foot"><span className="live-dot" />控制面在线<small>Worker API 已接入 · 节点待配置</small></div>
      </aside>

      <section className="workspace" id="overview">
        {anyDemo && (
          <div className="demo-banner" role="status">
            <strong>演示模式</strong>
            <span>
              页面上的进度与 SOH 数值由演示引擎生成，<b>并非 PyBaMM 计算结果</b>，不可用于商业质保决策。
              真实结果需等待计算面（Python worker）接入，见 <code>docs/deployment-and-capacity.md</code>。
            </span>
          </div>
        )}

        <header className="topbar"><div><p className="eyebrow">BATTERY DIGITAL TWIN</p><h1>储能寿命与质保仿真</h1></div><div className="top-actions"><span className="sync-pill">● {notice}</span><button className="avatar" aria-label="用户菜单">RZ</button></div></header>

        <div className="metrics">
          <article><span>运行中任务</span><strong>{auth === "authenticated" ? activeCount : EM_DASH}</strong><small>{auth === "authenticated" ? "用户退出后继续执行" : "登录后显示"}</small></article>
          <article><span>已完成任务</span><strong>{auth === "authenticated" ? completedCount : EM_DASH}</strong><small>当前查询范围内</small></article>
          <article><span>模型版本</span><strong>{current?.modelVersion ?? EM_DASH}</strong><small>以任务记录为准</small></article>
          <article><span>计算节点负载</span><strong>{EM_DASH}</strong><small>计算面接入后可用</small></article>
        </div>

        <section className="workflow-strip" aria-label="标准仿真流程">
          {["建立产品档案", "导入测试数据", "标定模型", "配置标准工况", "执行仿真", "审核并发布"].map((step, index) => (
            <div className={index === 0 ? "ready" : "pending"} key={step}><i>{index + 1}</i><span>{step}</span><small>{index === 0 ? "可开始" : "等待上游"}</small></div>
          ))}
        </section>

        <div className="primary-grid">
          <section className="panel builder">
            <div className="panel-head"><div><p className="eyebrow">NEW SIMULATION</p><h2>创建仿真任务</h2></div><span className="tag">异步执行</span></div>
            <form onSubmit={submitRun}>
              <label>任务名称<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></label>
              <div className="form-row">
                <label>电芯体系<select><option>CALB LFP · 参数集待校准</option></select></label>
                <label>模型精度<select><option>工程级 · SPMe + SOH</option><option>快速 · 半经验模型</option></select></label>
              </div>
              <div className="range-row"><label>仿真年限 <b>{horizon} 年</b><input type="range" min="1" max="25" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} /></label><label>每日循环 <b>{cycles.toFixed(2)} 次</b><input type="range" min="0.25" max="3" step="0.25" value={cycles} onChange={(e) => setCycles(Number(e.target.value))} /></label></div>
              <div className="assumptions"><span>环境温度 <b>25 °C</b></span><span>初始 SOC <b>50%</b></span><span>DoD <b>90%</b></span><span>EOL <b>80%</b></span></div>
              <button className="primary-button" disabled={submitting}>{submitting ? "正在提交…" : "启动持久仿真任务"}<span>→</span></button>
              <p className="helper">提交后任务进入服务器队列。关闭浏览器、退出登录或更换设备均不会终止计算。</p>
            </form>
          </section>

          <section className="panel result-card">
            <div className="panel-head"><div><p className="eyebrow">LIVE FORECAST</p><h2>SOH 预测曲线</h2></div><span className={`status ${current?.status ?? "queued"}`}>{current ? statusLabel[current.status] : "暂无"}</span></div>
            <p className="chart-caveat">{currentSohResult ? `正式结果 · ${currentSohResult.result_version}` : "示意图形 · 尚未载入正式计算结果"}</p>
            {currentSohResult ? <div className="result-series" aria-label="年度 SOH 结果">{currentSohResult.points.map((point) => <div key={point.year} className={point.within_validity_envelope ? "" : "outside"} title={`第 ${point.year} 年 · SOH ${(point.predicted_capacity_fraction * 100).toFixed(2)}%`}><i style={{ height: `${Math.max(2, point.predicted_capacity_fraction * 100)}%` }} /><span>{point.year}</span></div>)}</div> : <div className="chart-wrap">
              <div className="chart-labels"><span>100%</span><span>90%</span><span>80%</span><span>70%</span></div>
              <div className="chart"><div className="eol-line"><span>质保阈值 80%</span></div><div className="curve" /><div className="curve-glow" /><div className="chart-years"><span>0</span><span>5</span><span>10</span><span>15</span><span>20 年</span></div></div>
            </div>}
            <div className="forecast-stats">
              <div><span>预测期末 SOH{current?.demo ? " · 演示值" : ""}</span><strong>{current?.endSoh != null ? `${current.endSoh}%` : EM_DASH}</strong></div>
              <div><span>累计吞吐量</span><strong>{EM_DASH}</strong></div>
              <div><span>质保余量</span><strong>{EM_DASH}</strong></div>
            </div>
            <div className="progress-block"><div><span>任务进度 · {current?.id ?? EM_DASH}</span><b>{current?.progress ?? 0}%</b></div><progress value={current?.progress ?? 0} max="100" /></div>
            {current && !current.demo && <div className="evidence-summary"><div><span>执行引擎</span><b>{current.engine}</b></div><div><span>代码修订</span><b>{current.codeRevision?.slice(0, 12) ?? EM_DASH}</b></div><div><span>有效性包络</span><b>{current.withinValidityEnvelope === null ? "待结果" : current.withinValidityEnvelope ? "范围内" : "超出范围"}</b></div><div><span>工程审核</span><b>{currentSohResult?.engineering_review_eligible ? "可进入审核" : "尚不可审核"}</b></div></div>}
            {!!currentDetail?.artifacts.length && <div className="artifact-links"><span>结果证据</span>{currentDetail.artifacts.map((artifact) => <a key={artifact.kind} href={`${artifact.href}?download=1`}>{artifact.kind}<small>{artifact.sizeBytes == null ? EM_DASH : `${artifact.sizeBytes} B`} · {artifact.checksum?.slice(0, 10) ?? EM_DASH}</small></a>)}</div>}
          </section>
        </div>

        <section className="panel runs" id="runs">
          <div className="panel-head"><div><p className="eyebrow">PERSISTENT JOB QUEUE</p><h2>最近任务</h2></div><button className="text-button">查看全部 →</button></div>
          <form className="compact-form standard-study-form" onSubmit={submitStandardStudy}>
            <label>已发布标准工况<select value={selectedStandardScenario} onChange={(event) => setSelectedStandardScenario(event.target.value)} required><option value="">请选择</option>{standardScenarios.filter((item) => item.status === "released").map((item) => <option key={item.id} value={item.id}>{item.name} · {item.code}-V{item.version}</option>)}</select></label>
            <label>已批准校准<select value={selectedCalibration} onChange={(event) => setSelectedCalibration(event.target.value)} required><option value="">请选择</option>{calibrations.filter((item) => item.status === "approved").map((item) => { const product = products.find((candidate) => candidate.id === item.productId); return <option key={item.id} value={item.id}>{product ? `${product.model} ${product.revision} · ` : ""}{item.modelVersion}</option>; })}</select></label>
            <label>研究起始日<input type="date" value={studyStartDate} onChange={(event) => setStudyStartDate(event.target.value)} required /></label>
            <button className="secondary-button" disabled={submittingStandardStudy}>{submittingStandardStudy ? "正在入队…" : "启动真实标准研究"}</button>
          </form>
          <p className="helper">仅使用已发布产品、已发布标准工况及已批准校准；任务保存完整 V0.2 输入证据并由独立 Python Worker 异步执行。</p>
          <div className="table"><div className="table-row table-head"><span>任务</span><span>工况</span><span>进度</span><span>状态</span><span>期末 SOH</span></div>{runs.slice(0, 5).map((run) => <button className={`table-row ${selected === run.id ? "selected" : ""}`} key={run.id} onClick={() => setSelected(run.id)}><span><b>{run.name}</b><small>{run.id}</small></span><span>{run.horizonYears} 年 · {run.cyclesPerDay} 循环/日</span><span><progress value={run.progress} max="100" /> {run.progress}%</span><span><i className={`mini-dot ${run.status}`} />{statusLabel[run.status]}{run.demo && <em className="demo-chip">演示</em>}</span><span>{run.endSoh != null ? `${run.endSoh}%` : EM_DASH}</span></button>)}</div>
        </section>

        <div className="domain-grid">
          <section className="panel domain-card" id="products">
            <div className="panel-head"><div><p className="eyebrow">PRODUCT REGISTRY</p><h2>产品与方案档案</h2></div><span className="stage-badge demo">示例草稿</span></div>
            <form className="compact-form" onSubmit={saveProduct}><label>电芯型号<input value={productModel} onChange={(event) => setProductModel(event.target.value)} placeholder="输入正式型号" required /></label><label>额定容量 Ah<input type="number" min="1" max="2000" value={capacityAh} onChange={(event) => setCapacityAh(Number(event.target.value))} required /></label><label>数据修订<input value={revision} onChange={(event) => setRevision(event.target.value)} required /></label><button className="secondary-button">保存产品草稿</button></form>
            <div className="record-summary"><div><span>当前工作产品</span><strong>{productId ? productModel : "尚未保存"}</strong></div><div><span>参数集</span><strong>尚未发布</strong></div><div><span>数据成熟度</span><strong>{productId ? "L0 · 已建档" : "L0 · 待建档"}</strong></div></div>
            <div className="action-row"><span className="helper">记录为草稿，不代表 CALB 正式发布产品参数。</span><button className="text-button" onClick={() => navigateTo("test-data")}>进入数据导入 →</button></div>
          </section>

          <section className="panel domain-card" id="test-data">
            <div className="panel-head"><div><p className="eyebrow">TEST DATA INTAKE</p><h2>测试数据导入</h2></div><span className="stage-badge waiting">待接入</span></div>
            <form className="dataset-form" onSubmit={registerDataset}><div className="form-row"><label>测试类型<select value={datasetType} onChange={(event) => setDatasetType(event.target.value)}><option value="cycle_aging">循环老化</option><option value="calendar_aging">日历老化</option><option value="hppc">HPPC</option><option value="temperature">温度特性</option></select></label><label>电芯批次<input value={batchCode} onChange={(event) => setBatchCode(event.target.value)} required /></label></div><div className="form-row"><label>样品编号<input value={sampleCode} onChange={(event) => setSampleCode(event.target.value)} required /></label><label>设备 / 通道编号<input value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)} required /></label></div><div className="form-row"><label>测试机构 / 实验室<input value={sourceLab} onChange={(event) => setSourceLab(event.target.value)} required /></label><label>责任操作员<input value={operator} onChange={(event) => setOperator(event.target.value)} required /></label></div><div className="form-row"><label>测试开始时间<input type="datetime-local" value={testStartedAt} onChange={(event) => setTestStartedAt(event.target.value)} required /></label><label>测试结束时间<input type="datetime-local" value={testEndedAt} onChange={(event) => setTestEndedAt(event.target.value)} required /></label></div><label>单位 / 列映射声明<input value={unitSchema} onChange={(event) => setUnitSchema(event.target.value)} maxLength={2000} placeholder="例如 canonical-csv-V0.2 或受控映射版本" required /></label><div className="drop-zone"><strong>{datasetFile?.name ?? "选择测试数据包"}</strong><span>CSV / XLSX 原始字节将写入私有对象存储；服务器独立计算 SHA-256 和 CSV 行数，源文件不会被覆盖。</span><input type="file" accept=".csv,.xlsx" onChange={(event) => setDatasetFile(event.target.files?.[0] ?? null)} required /><button type="submit" disabled={submittingDataset}>{submittingDataset ? "正在上传…" : "上传不可变源数据"}</button></div></form>
            <details className="advanced-panel"><summary>验证策略与数据修订</summary><form className="compact-form" onSubmit={createValidationPolicy}><label>策略版本<input value={policyVersion} onChange={(event) => setPolicyVersion(event.target.value)} required /></label><div className="form-row"><label>最低电压 V<input type="number" step="any" value={policyBounds.voltageMinV} onChange={(event) => setPolicyBounds((value) => ({ ...value, voltageMinV: event.target.value }))} required /></label><label>最高电压 V<input type="number" step="any" value={policyBounds.voltageMaxV} onChange={(event) => setPolicyBounds((value) => ({ ...value, voltageMaxV: event.target.value }))} required /></label></div><div className="form-row"><label>最大绝对电流 A<input type="number" step="any" value={policyBounds.absoluteCurrentMaxA} onChange={(event) => setPolicyBounds((value) => ({ ...value, absoluteCurrentMaxA: event.target.value }))} required /></label><label>最低温度 °C<input type="number" step="any" value={policyBounds.temperatureMinC} onChange={(event) => setPolicyBounds((value) => ({ ...value, temperatureMinC: event.target.value }))} required /></label><label>最高温度 °C<input type="number" step="any" value={policyBounds.temperatureMaxC} onChange={(event) => setPolicyBounds((value) => ({ ...value, temperatureMaxC: event.target.value }))} required /></label></div><button className="secondary-button">保存策略草稿</button></form><div className="review-history">{validationPolicies.map((policy) => <article key={policy.id}><b>{policy.version} · {policy.status}</b><span>{policy.voltageMinV}–{policy.voltageMaxV} V · |I|≤{policy.absoluteCurrentMaxA} A · {policy.temperatureMinC}–{policy.temperatureMaxC} °C</span>{policy.status === "draft" && <button type="button" className="text-button" onClick={() => approveValidationPolicy(policy.id)}>确认来自正式试验计划并批准</button>}</article>)}</div><form className="dataset-form" onSubmit={submitDatasetRevision}><div className="form-row"><label>原始数据<select value={selectedDataset} onChange={(event) => setSelectedDataset(event.target.value)} required><option value="">选择已上传 CSV</option>{datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.testType}</option>)}</select></label><label>批准验证策略<select value={selectedValidationPolicy} onChange={(event) => setSelectedValidationPolicy(event.target.value)} required><option value="">选择批准策略</option>{validationPolicies.filter((item) => item.status === "approved").map((item) => <option key={item.id} value={item.id}>{item.version}</option>)}</select></label></div><div className="form-row"><label>数据修订<input value={datasetRevisionVersion} onChange={(event) => setDatasetRevisionVersion(event.target.value)} required /></label><label>代码修订<input value={datasetRevisionCode} onChange={(event) => setDatasetRevisionCode(event.target.value)} minLength={7} required /></label></div><label>列与单位映射 JSON<textarea value={mappingJson} onChange={(event) => setMappingJson(event.target.value)} required /></label>{datasets.find((item) => item.id === selectedDataset)?.testType === "cycle_aging" && <label>循环步骤策略 JSON<textarea value={cyclePolicyJson} onChange={(event) => setCyclePolicyJson(event.target.value)} required /></label>}<button className="secondary-button" disabled={submittingRevision}>{submittingRevision ? "正在提交…" : "创建数据修订任务"}</button></form><div className="review-history">{datasetRevisions.slice(0, 5).map((item) => <article key={item.id}><b>{item.revision} · {item.processingStatus} · {item.validationStatus}</b><span>{item.rowCount ?? "待计算"} 行 · 吞吐量 {item.totalAbsoluteThroughputAh ?? "—"} Ah · EFC {item.totalEquivalentFullCycles ?? "—"}</span>{item.processingStatus === "completed" && <a href={`/api/dataset-revisions/${item.id}/artifacts/validation-report.json`}>下载质量报告</a>}{item.error && <small>{item.error}</small>}</article>)}</div></details>
            <p className="boundary-note">导入数据必须保留来源、批次、测试设备、时间范围和单位；未经审核的数据不能用于发布模型。</p>
          </section>

          <section className="panel domain-card" id="models">
            <div className="panel-head"><div><p className="eyebrow">MODEL CALIBRATION</p><h2>模型与标定</h2></div><span className="stage-badge waiting">等待数据</span></div>
            <div className="model-lines"><div><span>PyBaMM SPMe</span><b>参考运行器已建立</b></div><div><span>SOH 半经验模型</span><b>契约已定义</b></div><div><span>有效性边界</span><b>待测试数据标定</b></div></div>
            <button className="secondary-button" onClick={() => setNotice("需要先导入并审核测试数据")}>创建标定任务</button>
          </section>

          <section className="panel domain-card" id="results">
            <div className="panel-head"><div><p className="eyebrow">RESULT COMPARISON</p><h2>结果版本对比</h2></div><span className="stage-badge ready">独立计算队列</span></div>
            <form className="compact-form" onSubmit={submitComparison}>
              <label>基准结果<select value={comparisonBaseline} onChange={(event) => setComparisonBaseline(event.target.value)} required><option value="">选择已完成标准研究</option>{comparableRuns.map((run) => <option key={run.id} value={run.id}>{run.name} · {run.id.slice(0, 8)}</option>)}</select></label>
              <label>当前结果<select value={comparisonCurrent} onChange={(event) => setComparisonCurrent(event.target.value)} required><option value="">选择不同版本</option>{comparableRuns.map((run) => <option key={run.id} value={run.id}>{run.name} · {run.id.slice(0, 8)}</option>)}</select></label>
              <label>对比版本<input value={comparisonVersion} onChange={(event) => setComparisonVersion(event.target.value)} minLength={1} maxLength={80} required /></label>
              <label>代码修订<input value={comparisonCodeRevision} onChange={(event) => setComparisonCodeRevision(event.target.value)} minLength={7} maxLength={64} required /></label>
              <button className="secondary-button" disabled={submittingComparison || comparableRuns.length < 2 || comparisonBaseline === comparisonCurrent}>{submittingComparison ? "正在提交…" : "创建不可变对比"}</button>
            </form>
            <p className="boundary-note">仅允许两个已完成的真实标准研究；时间轴、吞吐量、循环数和 EFC 使用显式工程容差校验。对比结果用于版本追踪，不自动构成质保变更。</p>
            <div className="review-history"><strong>对比任务</strong>{comparisons.length ? comparisons.slice(0, 5).map((item) => <article key={item.id}><b>{item.comparisonVersion} · {statusLabel[item.status]}</b><span>{item.finalCapacityDeltaFraction === null ? "等待计算结果" : `期末容量差 ${(item.finalCapacityDeltaFraction * 100).toFixed(3)}%，最大绝对差 ${(item.maximumAbsoluteCapacityDeltaFraction! * 100).toFixed(3)}%`}</span><small>{item.baselineRunId.slice(0, 8)} → {item.currentRunId.slice(0, 8)} · 尝试 {item.attempt}{item.error ? ` · ${item.error}` : ""}</small>{item.status === "completed" && <a href={`/api/study-comparisons/${encodeURIComponent(item.id)}/artifacts/comparison-result.json?download=1`}>下载不可变对比结果</a>}</article>) : <div className="empty-state"><strong>尚无对比任务</strong><span>先完成至少两个标准研究版本，再创建对比。</span></div>}</div>
          </section>

          <section className="panel domain-card full" id="warranty">
            <div className="panel-head"><div><p className="eyebrow">REVIEW &amp; WARRANTY</p><h2>审核与质保分析</h2></div><span className={`stage-badge ${latestReview?.decision === "approved" ? "ready" : "waiting"}`}>{latestReview ? ({ approved: "工程审核通过", changes_requested: "要求修改", rejected: "工程审核拒绝" }[latestReview.decision]) : "待工程审核"}</span></div>
            <div className="review-flow"><span>技术校核<small>模型边界与误差</small></span><b>→</b><span>业务审核<small>标准工况与口径</small></span><b>→</b><span>版本发布<small>生成不可变结果</small></span><b>→</b><span>质保分析<small>阈值与余量</small></span></div>
            {current?.engine === "standard-study" && current.status === "completed" ? <div className="review-workbench"><div className="review-history"><strong>当前结果审核记录</strong>{currentReviews.length ? currentReviews.map((review) => <article key={review.id}><b>{({ approved: "通过", changes_requested: "要求修改", rejected: "拒绝" }[review.decision])}</b><span>{review.comment}</span><small>{new Date(review.createdAt).toLocaleString("zh-CN")} · {review.reviewerEmail ?? "已认证审核人"} · 证据 {review.sohResultChecksumSha256.slice(0, 10)}</small></article>) : <p className="helper">尚无审核决定。通过决定只允许写入包络内、物理有效且证据完整的正式结果。</p>}</div><form className="review-form" onSubmit={submitEngineeringReview}><label>审核决定<select value={reviewDecision} onChange={(event) => setReviewDecision(event.target.value as EngineeringReview["decision"])}><option value="approved">工程审核通过</option><option value="changes_requested">要求修改 / 补充证据</option><option value="rejected">拒绝当前结果</option></select></label><label>审核意见<textarea value={reviewComment} onChange={(event) => setReviewComment(event.target.value)} minLength={10} maxLength={2000} placeholder="记录模型边界、数据充分性和用途限制，至少 10 个字符" required /></label><button className="secondary-button" disabled={submittingReview}>{submittingReview ? "正在保存…" : "记录审核决定"}</button><p className="helper">工程审核不会把结果自动转为质保承诺；当前模型尚未完成系统层折算与不确定性量化。</p></form></div> : <p className="boundary-note">请选择一个已完成的真实标准研究后进行审核。演示任务不能进入审核或质保流程。</p>}
          </section>
        </div>
        <footer className="project-footer"><span>CALB ESS Digital Twin · V0.1</span><span>Concept &amp; System Design · Alex.Z</span><span>© 2026 Alex.Z</span></footer>
      </section>
    </main>
  );
}
