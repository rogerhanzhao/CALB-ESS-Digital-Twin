# V0.1 设计审核记录（Design Review）

- 审核对象：`CALB-ESS-Digital-Twin` @ `5e4c23e`（V0.1）
- 审核范围：Python 计算骨架、`web/` 控制面、`docs/` 设计文档、数据模型与部署选型
- 审核日期：2026-08-09
- 文档状态：**已定稿，作为 V0.2 的实施基线**

> 说明：本文件为团队评审记录，使用中文。`docs/architecture.md` 与 `docs/data-model.md`
> 为工程规范文档，沿用仓库既有英文体例。

---

## 1. 结论摘要

分层设计（`cell_database → pybamm_models → soh_engine → dispatch → warranty`）本身成立，
`docs/deployment-and-capacity.md` 的质量明显高于一般 V0.1 项目。**真正的风险不在分层，而在三处**：

| # | 风险 | 性质 |
|---|---|---|
| R1 | Cloudflare Workers / D1 承载不了 PyBaMM | 平台选型与需求冲突，不是「以后接上」 |
| R2 | 缺少两级模型策略（高保真标定 + 降阶外推） | 决定项目**算不算得动** |
| R3 | 电芯 SOH 到系统级质保之间缺一整层折算 | 决定结论**能不能用** |

其余问题（伪进度写库、schema 过窄、API 细节、CI 缺失）属于可按部就班收敛的工程债。

---

## 2. 现状快照

| 层 | 状态 | 证据 |
|---|---|---|
| 部署与容量文档 | 成熟。服务拆分、容量分层、租约/心跳/checkpoint、审计包均已定义 | `docs/deployment-and-capacity.md` |
| `web/` 控制面 | 已部署可用：vinext + Cloudflare Workers + D1 + Drizzle + SIWC 认证 | `web/` |
| `src/calb_ess_digital_twin/` | **5 个模块全为空**，仅有 docstring，零实现 | 各 `__init__.py` |
| `pybamm` 依赖 | 已声明但从未 import | `pyproject.toml:12` |
| 测试 | 唯一用例是 `assert __version__ == "0.1.0"` | `tests/test_package.py` |
| CI | 不存在 | 无 `.github/workflows/` |

一句话概括：**文档很成熟、Web 很完整、内核完全为空。**

---

## 3. 发现清单

### P0-1　平台选型与需求冲突

**现象**　`docs/deployment-and-capacity.md` 描述的是「轻量 Web 控制面 + Python 计算 worker」，
但实际选型是 Cloudflare Workers + D1。Workers 运行时无法承载 PyBaMM（CPython 科学栈、
CPU 密集、分钟至小时级长任务、需要本地 scratch）。

**证据**　`web/worker/index.ts`、`web/.openai/hosting.json`（`"r2": null`）；
仓库内无 Dockerfile、无 worker 进程、无队列客户端、无对象存储绑定。

**影响**　文档承诺与代码实现的差距会随时间持续扩大；`r2: null` 意味着大结果与审计包无处存放，
而审计包是商业质保运行的硬性要求。

**建议**
- 明确 **D1 / Workers 只做控制面与元数据**，不承担任何数值计算。
- 计算跑在容器 / VM（队列用 Cloudflare Queues 或 SQS/Redis，消费者为容器化 Python worker）。
- 打开 R2 绑定，用于结果时序、日志与审计包。
- 先在仓库内建出该链路的**最小骨架**（`compute/` 目录 + Dockerfile + 队列消费循环），
  即使内部逻辑仍是桩，也要让契约先跑通。

---

### P0-2　伪进度正在写回真数据库

**现象**　`GET /api/simulations` 会把伪造的 `progress / status / endSoh` **持久化 UPDATE 进 D1**。

**证据**
- `web/app/api/simulations/route.ts:9-14`　`advance()`：进度由墙钟时间线性推进
  （`Math.floor(elapsed / 1800)`，即 180 秒跑满 100%）；`endSoh` 为手写线性式
  `84.6 - horizonYears*0.17 - cyclesPerDay*0.4`，与 PyBaMM 无任何关系。
- `web/app/api/simulations/route.ts:22-27`　读路径内执行 `db.update(...)`。

**影响**
1. 接入真实 worker 之前，库中已积累一批带假 `endSoh` 的 `completed` 记录，**事后无法区分真假**。
2. 接入之后，`Math.max(run.progress, elapsed/1800)` 会与真实 worker 的写入**互相竞争覆盖**。
3. `advance()` 在 `progress < 100` 时把 `endSoh` 置 `null`，会抹掉已有结果。

**建议**
- 读路径不得写库（GET 恢复为纯只读）。
- 记录增加 `engine` 字段（`'demo' | 'pybamm'`），demo 结果永久携带标记且不可转正。
- 伪进度只在渲染层推导，不落库。

---

### P0-3　UI 未标注演示模式

**现象**　`docs/deployment-and-capacity.md` 诚实地标注了 “deployment-safe demonstrator”，
但页面上呈现的是「计算服务在线」「2 / 5 workers active」「↑ 18% vs. 上月」
「累计吞吐量 13.1 GWh」「质保余量 +1.2%」，且 SOH 曲线是纯 CSS 画的静态形状。

**证据**　`web/app/page.tsx:85`、`:92-95`、`:118`、`:120`；
`web/app/page.tsx:46` 在 401 时静默回退到演示数据，用户不知道自己未登录。

**影响**　不读文档的使用者会认为这是真实运行数据。对于承载**商业质保决策**的产品，
这是必须优先消除的表述风险。

**建议**
- 页面顶部常驻显著的「演示模式 / DEMO」横幅，说明数值不可用于商业决策。
- 未登录时明确提示，而非静默降级。
- 所有硬编码指标（本月完成数、节点负载、吞吐量、质保余量）在无真实数据源时显示 `—`，不得编造。

---

### P0-4　单电芯 SOH 直接当作系统级质保结论（R3）

**现象**　`configs/baseline_lfp.yaml` 是**电芯口径**（EOL 0.8、DoD 0.9、每日循环数），
而 `warranty` 模块的产出是**系统口径**的商业承诺。两者之间缺少一整层折算。

**缺失的折算项**
- 成组损失（cell → module → rack → system）
- SOC 运行窗口（可用容量 ≠ 额定容量）
- 辅助功耗与温控能耗（影响 RTE 与实际吞吐）
- **电芯不一致性 / 离散度**——对系统可用容量的影响常大于单体衰减本身
- 往返效率（RTE）衰减曲线

**质保侧缺项**
- 逐年能量保证曲线（而非单一 EOL 阈值）
- 可用率（availability）定义与计算口径
- augmentation 时点、容量与成本模型
- 超温 / 超循环 / 超 DoD 的免责边界条款
- `confidence_level: 0.95` 已写入配置，但**未定义不确定度来源**（参数不确定度？
  样本方差？Monte Carlo 抽样？外推误差？）——质保是商业承诺，此项必须先定义

**建议**　在 `warranty` 之前新增 `system/`（或 `pack/`）层，显式承载 cell→system 折算；
不确定度来源在 `docs/architecture.md` 中定义为一等概念，并写入结果 schema。

---

### P1-1　缺少两级模型策略（R2）

**现象**　20 年 × 每日 1–3 次循环做全 PyBaMM 逐循环仿真，在算力上不现实。
可行路径是「PyBaMM 高保真标定 → 半经验 / 降阶模型外推」
（例如按温度 / DoD / 平均 SOC 分箱的 `Q_loss = a·t^0.5 + b·Ah^c`）。

**值得注意的是**：前端 UI 已经提供了这两档选择
（`web/app/page.tsx:105`：「工程级 · SPMe + SOH」/「快速 · 半经验模型」），
但 `docs/architecture.md` 完全没有描述该策略——**UI 已经领先于架构文档**。

**建议**
- 将两级模型策略正式写入架构文档，作为项目的核心技术决策。
- `soh_engine` 下拆分 `calibration/`（对真实老化数据拟合）与 `extrapolation/`（长期外推）。
- 定义验证指标（RMSE、外推误差）与**明确的模型适用边界**（温度区间、DoD 区间、
  外推有效年限）。超出边界的运行必须在结果中标注为不可用于质保。

---

### P1-2　数据模型过窄，且违反自身文档的可审计要求

**现象**　`docs/architecture.md` 要求保留 “input-data versions, model versions,
assumptions, run identifiers”，但 `web/db/schema.ts` 中**一项都没有**。
当前表仅有 `horizonYears / cyclesPerDay / chemistry / endSoh`。
`docs/deployment-and-capacity.md` 要求持久化 heartbeat / attempt / checkpoint URI，
同样全部缺失。

**影响**　输入定义与执行记录混在一张表，无法表达
「同一场景换模型版本重跑并对比」——而这恰恰是质保分析最核心的用法。
结果被压缩为单个 `endSoh` 标量，逐年 SOH / 吞吐量 / 阻抗增长曲线无处存放。

**建议**　拆分为三张表，详见 `docs/data-model.md`：

| 表 | 职责 |
|---|---|
| `scenarios` | 输入定义，可复用、可版本化（温度剖面、SOC 窗口、日历/循环拆分、电芯参数集版本） |
| `runs` | 一次执行（`scenario_id` + `model_version` + `code_revision` + `engine` + 作业执行字段） |
| `run_artifacts` | 结果时序与审计包指针（正文存 R2，库内只留元数据与校验和） |

---

### P1-3　API 正确性与完整性

| 位置 | 问题 | 建议 |
|---|---|---|
| `route.ts:40` | `id` 用 `Date.now().toString(36)`，同毫秒并发会撞主键 | 改 UUID；并支持客户端 `Idempotency-Key`（文档要求 idempotent job id） |
| `route.ts:36-37` | `Number(undefined)` → `NaN`，`Math.max(1, NaN)` → `NaN`，非法输入静默写入 NaN | 显式校验 + 400，禁止静默钳制 |
| `route.ts:40` | `chemistry` 用户输入直接透传，无白名单 | 枚举白名单校验 |
| `route.ts:20` | 无 `GET /:id`，前端 5 秒全量轮询 30 条 | 增加单条查询；长任务改 SSE 或退避轮询 |
| — | 无分页、无取消 / 删除任务 | 补齐 |
| — | 无 per-user 配额与限流（`deployment-and-capacity.md` 明确要求 quota） | 在控制面实现 |

### P1-4　Web 与 Python 之间没有契约层

作业 payload 与结果 schema 目前在两侧各写各的，完全脱节。

**建议**　新增 `contracts/`：以 pydantic 为**单一真相源**定义 job payload / result schema，
导出 JSON Schema，再生成 TypeScript 类型。CI 校验两侧一致性。
仓库已依赖 `pydantic`（`pyproject.toml:13`）但**零使用**，正好在此落地。

---

### P2-1　工程基建

- 无 CI，Python 与 web 均无 lint / test 门禁。
- **`npm test` 在 V0.1 基线上即为红**：`web/tests/rendered-html.test.mjs` 断言的
  `app/_sites-preview/SkeletonPreview.tsx` 在本仓库中从不存在，两个用例 100% 失败。
  该文件是脚手架残留，测试永远不可能通过——等于项目自始至终没有可用的测试门禁。
  （实施时已删除该死测试并补入真实用例，见 §5 M0。）
- `configs/baseline_lfp.yaml` 无 schema 校验，且 `nominal_capacity_ah: null`、`model: placeholder`。
- 无 run manifest / 结果指纹；`deployment-and-capacity.md` 要求 audit bundle 但未定义格式。
- `web/package.json:2` 的 name 仍是 `site-creator-vinext-starter`；
  `web/README.md` 整份是脚手架模板文档，没有本项目的任何说明
  （其中「`db/schema.ts` starts intentionally empty」在 V0.1 时已经是错的）。
- `idx_simulations_active_status`（单列 `status`）与实际查询模式
  `(user_id, created_at)` 不匹配，价值有限。

### P2-2　署名与合规上的一处矛盾

`NOTICE.md` / `README.md` / 页面页脚声明 `© 2026 Alex.Z, All rights reserved` + `Proprietary`，
同时项目冠以 **CALB**（中创新航，真实企业）之名，且有一次提交为
"Align dashboard with CALB visual identity"（`0f897e3`）。

这两件事存在矛盾：若为 CALB 内部项目，版权主体应为公司而非个人；
若为个人项目，则不宜使用真实企业名称与视觉识别。

此外，D1 中存储的 `user_id` / email 属于个人数据，
`README.md` 的数据治理章节只写了「raw data 不入库」，
**未定义个人数据的保留期与删除策略**。

> 此项需要项目负责人做出决定，工程侧不自行更改署名。

---

## 4. 修订后的目标架构

```text
                         ┌───────────────────────────────┐
   浏览器 ──────────────► │ 控制面 (Cloudflare Workers/D1) │
                         │  认证 / 校验 / 作业记录 / 进度  │
                         └───────────┬───────────────────┘
                                     │ 队列（至少一次投递 + 幂等 job id）
                                     ▼
                         ┌───────────────────────────────┐
                         │ 计算面 (容器化 Python worker)  │
                         │  租约 / 心跳 / checkpoint      │
                         └───────────┬───────────────────┘
                                     │
   ┌─────────────────────────────────┴─────────────────────────────┐
   │  cell_database → pybamm_models → soh_engine ──┐               │
   │                                   ├ calibration │             │
   │                                   └ extrapolation             │
   │                                               ▼               │
   │                          dispatch → system(折算) → warranty    │
   └───────────────────────────────┬───────────────────────────────┘
                                   ▼
                    结果时序 / 审计包 → 对象存储 (R2)
                    结构化摘要 → D1
```

相对原设计的三处变化：

1. **计算面独立**（P0-1）：控制面与计算面物理分离，队列为唯一接口。
2. **`soh_engine` 内部分层**（P1-1）：标定与外推分离，两级模型策略显式化。
3. **新增 `system` 折算层**（P0-4）：`dispatch` 与 `warranty` 之间不再直连。

---

## 5. 分阶段实施方案

### M0（本次提交，已完成）

方案 A：设计文档定稿。
方案 B：P0 工程修复。

- [x] `docs/design-review.md`（本文件）
- [x] `docs/architecture.md` 修订：补两级模型策略、系统折算层、契约层、计算面
- [x] `docs/data-model.md` 新增：三表模型与字段定义
- [x] 伪进度从写路径剥离，GET 恢复只读
- [x] `engine` 标记（`demo` / `pybamm`），demo 结果不可转正
- [x] UI 演示模式横幅 + 未登录显式提示 + 移除编造指标
- [x] schema 重构为 `scenarios` / `runs` / `run_artifacts` + 数据迁移
      （`drizzle/0002` 建表、`0003` 回填并删除旧表；旧数据一律标记 `engine = 'demo'`）
- [x] API 校验、UUID 主键、幂等键、单条查询、取消任务、分页、chemistry 白名单
- [x] 补充测试：`web/tests/runs.test.ts`（15 例），覆盖 P0-2 与 P1-3 的回归防线；
      删除永远不可能通过的脚手架死测试（§P2-1）
- [x] `docs/collaboration-claude-codex.md`：双智能体协同与交叉审核方案

- [x] CI 门禁：`.github/workflows/ci.yml`（计算面 ruff + pytest；控制面 lint + tsc + build + test；
      迁移漂移检查）。同时修复 `db/index.ts` / `worker/index.ts` 的 3 个既有类型错误，
      使 `tsc` 具备 gate 资格
- [x] `.github/pull_request_template.md`：把 §4 交叉审核 checklist 变成每个 PR 的强制项

M0 未包含（明确留给后续里程碑）：`contracts/`、`compute/` 骨架、R2 绑定、
Python 内核实现、`configs/*.yaml` 的 pydantic 校验、契约一致性 CI job（随 M1-C 落地）。

### M1（下一步，建议优先）

- [ ] `contracts/`：pydantic 定义 job payload / result schema，导出 JSON Schema → TS 类型
- [ ] `compute/` 最小骨架：Dockerfile + 队列消费循环 + 租约/心跳/checkpoint（逻辑可为桩）
- [ ] 打开 R2 绑定，跑通「worker 上传结果 → 控制面签发下载」链路
- [ ] CI：Python（ruff + pytest）与 web（eslint + build + test）门禁

### M2

- [ ] `soh_engine.calibration`：以真实老化数据拟合半经验模型，产出 RMSE 与适用边界
- [ ] `soh_engine.extrapolation`：长期外推 + 不确定度传播
- [ ] `pybamm_models`：LFP 基线参数集与可复现参考工况（README 已列为下一里程碑）
- [ ] `configs/*.yaml` 接入 pydantic 校验

### M3

- [ ] `system/` 折算层：成组损失、SOC 窗口、辅助功耗、不一致性、RTE 衰减
- [ ] `warranty`：逐年能量保证曲线、可用率、augmentation、免责边界
- [ ] 审计包格式定稿并实现（输入、代码版本、参数集版本、环境、日志、输出校验和）

---

## 6. 验收标准

1. **可审计**：任一 run 可还原出输入版本、模型版本、代码 revision、环境与输出校验和。
2. **可对比**：同一 `scenario` 在不同 `model_version` 下的结果可并列比较。
3. **可恢复**：worker 重启后从 checkpoint 续算或幂等重试，租约到期可被接管。
4. **可信**：任何 `engine = 'demo'` 的记录在 API 与 UI 上均显式标注，且不可用于质保结论。
5. **有边界**：超出模型适用边界的运行在结果中标注为不可用于质保。

---

## 7. 未决问题（需项目负责人决策）

| # | 问题 | 影响 |
|---|---|---|
| Q1 | 计算面部署在何处？（自建 K8s / 云容器服务 / 现有 HPC） | 决定 M1 的队列与镜像方案 |
| Q2 | 是否有可用的真实老化数据集及其规模？ | 决定 M2 能否真正标定；无数据则 SOH 引擎无法交付可信结论 |
| Q3 | 质保口径是电芯级还是系统级？系统边界如何定义？ | 决定 M3 折算层的范围 |
| Q4 | 项目署名与版权主体（P2-2） | 合规问题，工程侧不自行更改 |
| Q5 | 个人数据（user_id / email）保留期与删除策略 | 合规问题，需写入数据治理章节 |
