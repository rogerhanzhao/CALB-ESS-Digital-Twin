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
  createdAt: string;
  demo: boolean;
};

type AuthState = "unknown" | "anonymous" | "authenticated";
type SectionId = "overview" | "products" | "test-data" | "models" | "runs" | "results" | "warranty";

/**
 * Local preview rows. These exist so the layout is inspectable without a database
 * binding; they are flagged `demo` exactly like server-side demonstrator rows so the
 * interface never presents them as real results.
 */
const previewRuns: Simulation[] = [
  { id: "preview-1", scenarioId: "preview-1", name: "314 Ah · 20 年基准工况", status: "running", progress: 68, chemistry: "LFP", horizonYears: 20, cyclesPerDay: 1, endSoh: null, modelVersion: null, createdAt: "2026-08-09T08:42:00Z", demo: true },
  { id: "preview-2", scenarioId: "preview-2", name: "AIDC 两充两放压力测试", status: "completed", progress: 100, chemistry: "LFP", horizonYears: 15, cyclesPerDay: 2, endSoh: 76.8, modelVersion: null, createdAt: "2026-08-08T03:12:00Z", demo: true },
  { id: "preview-3", scenarioId: "preview-3", name: "JP 项目质保边界", status: "completed", progress: 100, chemistry: "LFP", horizonYears: 20, cyclesPerDay: 1, endSoh: 81.4, modelVersion: null, createdAt: "2026-08-07T11:08:00Z", demo: true },
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
        setSelected((current) =>
          payload.simulations.some((run) => run.id === current)
            ? current
            : payload.simulations[0]?.id ?? current,
        );
        setNotice("任务已同步 · 关闭页面不会中断计算");
      } catch {
        // Network failure during local preview: keep the rows already on screen.
      }
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const current = useMemo(
    () => runs.find((run) => run.id === selected) ?? runs[0],
    [runs, selected],
  );
  const activeCount = runs.filter((run) => run.status === "running" || run.status === "queued").length;
  const completedCount = runs.filter((run) => run.status === "completed").length;
  /** Every run is demonstrator output until a compute worker is connected. */
  const anyDemo = runs.some((run) => run.demo);

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
    const bytes = await datasetFile.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const checksumSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const rowCount = datasetFile.name.toLowerCase().endsWith(".csv") ? Math.max(0, new TextDecoder().decode(bytes).split(/\r?\n/).filter(Boolean).length - 1) : null;
    const now = new Date();
    const response = await fetch("/api/test-datasets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId, sampleCode, name: datasetFile.name, testType: datasetType, batchCode, sourceLab, equipmentId, operator, testStartedAt: new Date(now.getTime() - 3600000).toISOString(), testEndedAt: now.toISOString(), fileName: datasetFile.name, checksumSha256, rowCount, unitSchema: "待列映射审核" }) });
    const payload = await response.json() as { error?: string; details?: string[] };
    if (!response.ok) { setNotice(payload.details?.join("；") ?? payload.error ?? "登记失败"); return; }
    setNotice("测试数据元数据与 SHA-256 已登记；原始文件等待对象存储接入");
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
        <div className="sidebar-foot"><span className="live-dot" />控制面在线<small>计算面尚未接入</small></div>
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
          <article><span>模型版本</span><strong>{current?.modelVersion ?? EM_DASH}</strong><small>计算内核尚未接入</small></article>
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
            <p className="chart-caveat">示意图形 · 尚未由计算结果绘制</p>
            <div className="chart-wrap">
              <div className="chart-labels"><span>100%</span><span>90%</span><span>80%</span><span>70%</span></div>
              <div className="chart"><div className="eol-line"><span>质保阈值 80%</span></div><div className="curve" /><div className="curve-glow" /><div className="chart-years"><span>0</span><span>5</span><span>10</span><span>15</span><span>20 年</span></div></div>
            </div>
            <div className="forecast-stats">
              <div><span>预测期末 SOH{current?.demo ? " · 演示值" : ""}</span><strong>{current?.endSoh != null ? `${current.endSoh}%` : EM_DASH}</strong></div>
              <div><span>累计吞吐量</span><strong>{EM_DASH}</strong></div>
              <div><span>质保余量</span><strong>{EM_DASH}</strong></div>
            </div>
            <div className="progress-block"><div><span>任务进度 · {current?.id ?? EM_DASH}</span><b>{current?.progress ?? 0}%</b></div><progress value={current?.progress ?? 0} max="100" /></div>
          </section>
        </div>

        <section className="panel runs" id="runs">
          <div className="panel-head"><div><p className="eyebrow">PERSISTENT JOB QUEUE</p><h2>最近任务</h2></div><button className="text-button">查看全部 →</button></div>
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
            <form className="dataset-form" onSubmit={registerDataset}><div className="form-row"><label>测试类型<select value={datasetType} onChange={(event) => setDatasetType(event.target.value)}><option value="cycle_aging">循环老化</option><option value="calendar_aging">日历老化</option><option value="hppc">HPPC</option><option value="temperature">温度特性</option></select></label><label>电芯批次<input value={batchCode} onChange={(event) => setBatchCode(event.target.value)} required /></label></div><div className="form-row"><label>样品编号<input value={sampleCode} onChange={(event) => setSampleCode(event.target.value)} required /></label><label>设备 / 通道编号<input value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)} required /></label></div><div className="form-row"><label>测试机构 / 实验室<input value={sourceLab} onChange={(event) => setSourceLab(event.target.value)} required /></label><label>责任操作员<input value={operator} onChange={(event) => setOperator(event.target.value)} required /></label></div><div className="drop-zone"><strong>{datasetFile?.name ?? "选择测试数据包"}</strong><span>当前登记 CSV / XLSX 元数据、行数与 SHA-256；原始文件存储将在对象存储接入后启用</span><input type="file" accept=".csv,.xlsx" onChange={(event) => setDatasetFile(event.target.files?.[0] ?? null)} required /><button type="submit">登记数据集</button></div></form>
            <p className="boundary-note">导入数据必须保留来源、批次、测试设备、时间范围和单位；未经审核的数据不能用于发布模型。</p>
          </section>

          <section className="panel domain-card" id="models">
            <div className="panel-head"><div><p className="eyebrow">MODEL CALIBRATION</p><h2>模型与标定</h2></div><span className="stage-badge waiting">等待数据</span></div>
            <div className="model-lines"><div><span>PyBaMM SPMe</span><b>参考运行器已建立</b></div><div><span>SOH 半经验模型</span><b>契约已定义</b></div><div><span>有效性边界</span><b>待测试数据标定</b></div></div>
            <button className="secondary-button" onClick={() => setNotice("需要先导入并审核测试数据")}>创建标定任务</button>
          </section>

          <section className="panel domain-card" id="results">
            <div className="panel-head"><div><p className="eyebrow">RESULT LIBRARY</p><h2>结果与版本</h2></div><span className="stage-badge demo">仅演示</span></div>
            <div className="empty-state"><strong>尚无可发布的仿真结果</strong><span>正式结果将绑定产品、数据版本、模型版本、代码修订和标准工况，历史版本不会被覆盖。</span></div>
          </section>

          <section className="panel domain-card full" id="warranty">
            <div className="panel-head"><div><p className="eyebrow">REVIEW &amp; WARRANTY</p><h2>审核与质保分析</h2></div><span className="stage-badge waiting">未开放</span></div>
            <div className="review-flow"><span>技术校核<small>模型边界与误差</small></span><b>→</b><span>业务审核<small>标准工况与口径</small></span><b>→</b><span>版本发布<small>生成不可变结果</small></span><b>→</b><span>质保分析<small>阈值与余量</small></span></div>
          </section>
        </div>
        <footer className="project-footer"><span>CALB ESS Digital Twin · V0.1</span><span>Concept &amp; System Design · Alex.Z</span><span>© 2026 Alex.Z</span></footer>
      </section>
    </main>
  );
}
