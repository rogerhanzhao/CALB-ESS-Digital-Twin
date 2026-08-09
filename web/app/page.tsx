"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Simulation = {
  id: string;
  name: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  chemistry: string;
  horizonYears: number;
  cyclesPerDay: number;
  endSoh: number | null;
  createdAt: string;
};

const demoRuns: Simulation[] = [
  { id: "ESS-260809-014", name: "314 Ah · 20 年基准工况", status: "running", progress: 68, chemistry: "LFP", horizonYears: 20, cyclesPerDay: 1, endSoh: null, createdAt: "2026-08-09T08:42:00Z" },
  { id: "ESS-260808-021", name: "AIDC 两充两放压力测试", status: "completed", progress: 100, chemistry: "LFP", horizonYears: 15, cyclesPerDay: 2, endSoh: 76.8, createdAt: "2026-08-08T03:12:00Z" },
  { id: "ESS-260807-009", name: "JP 项目质保边界", status: "completed", progress: 100, chemistry: "LFP", horizonYears: 20, cyclesPerDay: 1, endSoh: 81.4, createdAt: "2026-08-07T11:08:00Z" },
];

const statusLabel = { queued: "排队中", running: "计算中", completed: "已完成", failed: "失败" };

export default function Home() {
  const [runs, setRuns] = useState<Simulation[]>(demoRuns);
  const [selected, setSelected] = useState(demoRuns[0].id);
  const [name, setName] = useState("314 Ah · 20 年基准工况");
  const [horizon, setHorizon] = useState(20);
  const [cycles, setCycles] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("演示数据 · 登录后任务将持久保存");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/simulations", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as { simulations: Simulation[] };
        if (active && payload.simulations.length) {
          setRuns(payload.simulations);
          setSelected(payload.simulations[0].id);
          setNotice("任务已同步 · 关闭页面不会中断计算");
        }
      } catch { /* local preview keeps realistic demonstration data */ }
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const current = useMemo(() => runs.find((run) => run.id === selected) ?? runs[0], [runs, selected]);
  const activeCount = runs.filter((run) => run.status === "running" || run.status === "queued").length;

  async function submitRun(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await fetch("/api/simulations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, horizonYears: horizon, cyclesPerDay: cycles, chemistry: "LFP" }),
      });
      if (!response.ok) throw new Error("请先登录部署环境");
      const payload = (await response.json()) as { simulation: Simulation };
      setRuns((items) => [payload.simulation, ...items]);
      setSelected(payload.simulation.id);
      setNotice("任务已提交到持久队列，可安全关闭页面");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "任务提交失败");
    } finally { setSubmitting(false); }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><i /><i /><i /></span><div><strong>ESS Digital Twin</strong><small>CALB · ENGINEERING PLATFORM</small></div></div>
        <nav aria-label="主导航">
          <a className="nav-item active" href="#overview"><span>⌁</span>仿真工作台</a>
          <a className="nav-item" href="#runs"><span>◫</span>任务与结果</a>
          <a className="nav-item" href="#models"><span>◇</span>电芯模型库</a>
          <a className="nav-item" href="#warranty"><span>◎</span>质保分析</a>
        </nav>
        <div className="sidebar-foot"><span className="live-dot" />计算服务在线<small>队列与结果已持久化</small></div>
      </aside>

      <section className="workspace" id="overview">
        <header className="topbar"><div><p className="eyebrow">BATTERY DIGITAL TWIN</p><h1>储能寿命与质保仿真</h1></div><div className="top-actions"><span className="sync-pill">● {notice}</span><button className="avatar" aria-label="用户菜单">RZ</button></div></header>

        <div className="metrics">
          <article><span>运行中任务</span><strong>{activeCount}</strong><small>用户退出后继续执行</small></article>
          <article><span>本月已完成</span><strong>{Math.max(24, runs.filter((r) => r.status === "completed").length)}</strong><small>↑ 18% vs. 上月</small></article>
          <article><span>模型版本</span><strong>V0.1</strong><small>PyBaMM · LFP 基线</small></article>
          <article><span>计算节点负载</span><strong>42%</strong><small>2 / 5 workers active</small></article>
        </div>

        <div className="primary-grid">
          <section className="panel builder">
            <div className="panel-head"><div><p className="eyebrow">NEW SIMULATION</p><h2>创建仿真任务</h2></div><span className="tag">异步执行</span></div>
            <form onSubmit={submitRun}>
              <label>任务名称<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
              <div className="form-row">
                <label>电芯体系<select><option>CALB LFP · 参数集待校准</option></select></label>
                <label>模型精度<select><option>工程级 · SPMe + SOH</option><option>快速 · 半经验模型</option></select></label>
              </div>
              <div className="range-row"><label>仿真年限 <b>{horizon} 年</b><input type="range" min="1" max="25" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} /></label><label>每日循环 <b>{cycles.toFixed(1)} 次</b><input type="range" min="0.25" max="3" step="0.25" value={cycles} onChange={(e) => setCycles(Number(e.target.value))} /></label></div>
              <div className="assumptions"><span>环境温度 <b>25 °C</b></span><span>初始 SOC <b>50%</b></span><span>DoD <b>90%</b></span><span>EOL <b>80%</b></span></div>
              <button className="primary-button" disabled={submitting}>{submitting ? "正在提交…" : "启动持久仿真任务"}<span>→</span></button>
              <p className="helper">提交后任务进入服务器队列。关闭浏览器、退出登录或更换设备均不会终止计算。</p>
            </form>
          </section>

          <section className="panel result-card">
            <div className="panel-head"><div><p className="eyebrow">LIVE FORECAST</p><h2>SOH 预测曲线</h2></div><span className={`status ${current?.status ?? "queued"}`}>{current ? statusLabel[current.status] : "暂无"}</span></div>
            <div className="chart-wrap">
              <div className="chart-labels"><span>100%</span><span>90%</span><span>80%</span><span>70%</span></div>
              <div className="chart"><div className="eol-line"><span>质保阈值 80%</span></div><div className="curve" /><div className="curve-glow" /><div className="chart-years"><span>0</span><span>5</span><span>10</span><span>15</span><span>20 年</span></div></div>
            </div>
            <div className="forecast-stats"><div><span>预测期末 SOH</span><strong>{current?.endSoh ? `${current.endSoh}%` : "81.2%"}</strong></div><div><span>累计吞吐量</span><strong>13.1 GWh</strong></div><div><span>质保余量</span><strong className="green">+1.2%</strong></div></div>
            <div className="progress-block"><div><span>任务进度 · {current?.id}</span><b>{current?.progress ?? 0}%</b></div><progress value={current?.progress ?? 0} max="100" /></div>
          </section>
        </div>

        <section className="panel runs" id="runs">
          <div className="panel-head"><div><p className="eyebrow">PERSISTENT JOB QUEUE</p><h2>最近任务</h2></div><button className="text-button">查看全部 →</button></div>
          <div className="table"><div className="table-row table-head"><span>任务</span><span>工况</span><span>进度</span><span>状态</span><span>期末 SOH</span></div>{runs.slice(0, 5).map((run) => <button className={`table-row ${selected === run.id ? "selected" : ""}`} key={run.id} onClick={() => setSelected(run.id)}><span><b>{run.name}</b><small>{run.id}</small></span><span>{run.horizonYears} 年 · {run.cyclesPerDay} 循环/日</span><span><progress value={run.progress} max="100" /> {run.progress}%</span><span><i className={`mini-dot ${run.status}`} />{statusLabel[run.status]}</span><span>{run.endSoh ? `${run.endSoh}%` : "—"}</span></button>)}</div>
        </section>
        <footer className="project-footer"><span>CALB ESS Digital Twin · V0.1</span><span>Concept &amp; System Design · Alex.Z</span><span>© 2026 Alex.Z</span></footer>
      </section>
    </main>
  );
}
