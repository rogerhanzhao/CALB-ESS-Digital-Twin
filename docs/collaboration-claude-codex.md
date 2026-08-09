# Claude ↔ CODEX 双智能体协同开发与交叉审核方案

- 适用范围：`CALB-ESS-Digital-Twin` 全仓库
- 基线文档：`docs/design-review.md`（设计结论）、`docs/architecture.md`（架构）、`docs/data-model.md`（持久化契约）
- 文档状态：**待双方确认后生效**

---

## 0. 为什么需要专门的协同规则

两个智能体并行修改同一仓库有两类固有风险：

1. **互相覆盖**——同一文件被双方同时改写，后推送者静默抹掉前者的工作。
2. **同质化盲区**——两个 AI 可能犯同一类错误（编造数据、跳过 provenance、
   把伪实现当真实现），互审时**同时看不见**。V0.1 的伪进度写库问题
   （`docs/design-review.md` §P0-2）正是这类盲区的实例。

风险 1 用**所有权与分支纪律**解决；风险 2 用**数值对拍与属性测试**解决——
后者不依赖任何一方的判断力，靠机器裁决。这是本方案的核心。

---

## 1. 角色与所有权

两个智能体分别记为 **Agent-A** 与 **Agent-B**。角色按**平面**划分，
因为两个平面之间只有队列与契约一个接口，天然适合并行。

| 区域 | Primary（实现） | Reviewer（审核） |
|---|---|---|
| `contracts/` | **双方共同定稿，先于一切实现** | 双方 sign-off |
| `src/calb_ess_digital_twin/`（计算内核） | Agent-A | Agent-B |
| `compute/`（worker、Dockerfile、队列消费） | Agent-A | Agent-B |
| `web/`（控制面、API、UI） | Agent-B | Agent-A |
| `web/db/`、`web/drizzle/`（持久化） | Agent-B | Agent-A |
| `docs/` | 提出变更的一方 | 另一方 |
| `.github/workflows/`、`pyproject.toml`、根配置 | Agent-B | Agent-A |

**当前指派（M0 起）**：Agent-A = CODEX，Agent-B = Claude。
理由：Claude 已完成 M0 的 `web/` 侧 P0 改造与文档，继续持有控制面；
计算内核尚未开工，由 CODEX 从零建立，边界清晰、无历史包袱。
该指派可由项目负责人随时对调，对调后本表整体翻转。

**铁律**：Reviewer **不得直接修改 Primary 区域的实现代码**。
Reviewer 只能提交 finding（PR 评论）或**测试**；由 Primary 修复。
这是防止互相覆盖的第一道闸门，也保证「谁写的谁负责」。

---

## 2. 分支与提交纪律

### 2.1 分支

- Agent-A 使用 `codex/<milestone>-<topic>`；Agent-B 使用 `claude/<milestone>-<topic>`。
- 一律从最新 `origin/main` 切出，**禁止**跨智能体分支互相叠加提交。
- 每次开工前必须先读取实时状态，不得依赖记忆中的仓库状态：

```bash
git fetch origin --prune
git log --oneline origin/main -10
git status --short
```

### 2.2 单文件单主

同一 PR 内不得出现对方 Primary 区域的文件改动。
确需跨区改动（例如契约变更牵动两侧）时，拆成两个 PR，先合并契约侧。

### 2.3 易冲突文件的约定

| 文件 | 约定 |
|---|---|
| `web/drizzle/NNNN_*.sql` | 序号冲突高发。**必须 rebase 到最新 main 后重新 `npm run db:generate`**，禁止手工改序号 |
| `CHANGELOG.md` | 每个版本小节内，A 写「计算面」条目，B 写「控制面」条目，互不越界 |
| `docs/design-review.md` §5 实施方案 | 只勾选自己完成的项，不改对方条目文字 |
| `pyproject.toml` / `package.json` 依赖 | 新增依赖必须在 PR 描述中单列说明，供对方审核 |

---

## 3. 三层交叉验证机制

三层从弱到强，**越往下越不依赖智能体的主观判断**。

### L1　契约先行（Contract-first）

任何跨平面的工作开始前，先合并 `contracts/` PR：

- 以 **pydantic 为单一真相源**定义 job payload 与 result schema；
- 导出 JSON Schema，再生成控制面的 TypeScript 类型；
- CI 校验两侧一致（生成物与提交物 diff 必须为空）。

契约 PR 需要双方明确 sign-off 才能合并。此后两侧可完全并行，
接口分歧由 CI 而非讨论来暴露。

### L2　黄金用例盲测（Golden cases, blind）

`tests/golden/` 存放「输入 → 期望输出」的固定用例。规则：

1. Primary 提交实现与输入用例，**但不提交期望值**。
2. Reviewer **不阅读实现代码**，仅依据 `docs/architecture.md` 与
   `contracts/` 的规格，独立推导期望值并提交。
3. 两者不一致时，先判定是规格歧义还是实现缺陷——
   **规格歧义一律回到文档修订**，不允许直接改期望值迁就实现。

这是唯一能捕获「规格被实现悄悄改写」的机制。

### L3　双实现对拍与属性测试（机器裁决）

数值代码最有效的交叉验证，不依赖任何一方看懂对方的代码。

**对拍（differential testing）**
SOH 外推等核心数值路径写两份：

- Primary 写生产实现（向量化、性能优先）；
- Reviewer 写朴素参考实现（`reference/`，可读性优先，允许慢 100 倍）；
- CI 在随机采样的输入空间上对拍，要求 `|prod - ref| < tol`。

两份实现由不同智能体独立编写，同时犯同一个错误的概率远低于互相 review 漏看。

**属性测试（property-based）**
由 **Reviewer 编写断言，Primary 不得修改断言**——只能修实现。
本项目必须覆盖的性质：

| 性质 | 断言 |
|---|---|
| 单调性 | SOH 随时间不增；累计吞吐量不减 |
| 边界 | `cycles_per_day = 0` 时循环老化项为 0，仅剩日历老化 |
| 量纲 | 容量、能量、时间单位在层间传递不发生隐式换算 |
| 守恒 | 放电能量 ≤ 充电能量；RTE ∈ (0, 1] |
| 包络 | 超出 validity envelope 的输入必须返回标注，而非静默外推 |
| 单调响应 | 温度升高或 DoD 增大，衰减不减少 |

---

## 4. 交叉审核 Checklist

每个 PR 的 Reviewer 必须逐条回答。**前六条直接对应 V0.1 已发生的问题**，
不得跳过。

**回归防线（源自 V0.1 教训）**

- [ ] 是否引入了硬编码 / 编造的指标或示例数值？（§P0-3）
- [ ] 读路径（GET / 查询）是否写库？（§P0-2）
- [ ] 伪实现或占位逻辑是否被明确标记（`engine = 'demo'` 或等价物），且不可被误认为真实结果？（§P0-2）
- [ ] 是否记录了 provenance：`model_version` / `code_revision` / `cell_param_set_version`？（§P1-2）
- [ ] 越过 validity envelope 的运行是否被标注？（`architecture.md` §3）
- [ ] `warranty` 是否绕过 `system` 折算层直接读取电芯级 SOH？（§P0-4）

**通用**

- [ ] 输入是否显式校验并返回 4xx，而非静默钳制成 `NaN`？（§P1-3）
- [ ] 写入字段是否只由 `data-model.md` §写入所有权指定的唯一写者写入？
- [ ] 不确定度是否声明了来源？（`architecture.md` §5）
- [ ] 新增依赖是否必要且已在 PR 描述中说明？
- [ ] 是否有对应的 golden case 或属性测试？

Reviewer 输出格式统一为：`文件:行号 — 问题 — 建议`。
不确定的项标 `PLAUSIBLE`，已验证的标 `CONFIRMED`，便于 Primary 分级处理。

---

## 5. 里程碑节奏

每个里程碑走「契约 → 并行实现 → 集成」三段，PR 成对出现。

```text
  M-n 启动
    │
    ├─ [双方] contracts PR ──────── 双签合并（L1）
    │
    ├─ [A] 计算面实现 PR ──┐
    │                      ├── 互为 Reviewer（L2 + L3 + §4 checklist）
    ├─ [B] 控制面实现 PR ──┘
    │
    └─ [双方] 集成 PR ────── 端到端跑通，CI 全绿
```

里程碑内容见 `docs/design-review.md` §5（M0–M3）。M0 已完成，下一步为 M1。

**M1 的具体切分**

| PR | 责任方 | 内容 |
|---|---|---|
| M1-C | 双方 | `contracts/`：pydantic job payload / result schema + JSON Schema 导出 + TS 生成 |
| M1-A | Agent-A | `compute/` 最小骨架：Dockerfile、队列消费循环、租约/心跳/checkpoint（逻辑可为桩） |
| M1-B | Agent-B | 控制面接队列：入队、租约状态机、R2 绑定与结果签发 |
| M1-I | 双方 | 端到端集成：提交任务 → worker 消费 → 上传结果 → 前端展示真实数据 |
| M1-CI | Agent-B | CI 门禁：ruff + pytest + eslint + build + 契约一致性校验 |

M1 完成的标志：**前端不再需要 demo 横幅**——因为数据是真的了。

---

## 6. 冲突解决

1. 技术分歧以 `docs/design-review.md` 与 `docs/architecture.md` 为准。
2. 文档未覆盖的分歧：由提出方补充文档 PR，另一方 review，**先定文档再写代码**。
3. 仍无法解决的，记入 `docs/design-review.md` §7 未决问题，交项目负责人决策，
   **不得由任一智能体单方面决定**。
4. 涉及署名、版权、合规（§P2-2、Q4、Q5）的事项，两个智能体均不自行更改。

---

## 7. 实时状态同步

智能体没有持续在线的共享上下文，**必须把仓库当作唯一真相源**，每次开工重新读取：

```bash
git fetch origin --prune
git log --oneline origin/main -10          # 对方合并了什么
git diff --stat origin/main...HEAD          # 自己领先多少
```

并检查 `docs/design-review.md` §5 的勾选状态——那是里程碑进度的唯一记录。

不得依据对话记忆断言「某功能已实现」。**以 `git` 与 CI 结果为准。**

---

## 8. 启动动作（Kickoff）

本方案的**第一次交叉审核，就是审核提出本方案的那个 PR**。在 M1 开工前按顺序执行：

### 第 1 步　CODEX 审核 PR #1（M0）

PR #1 `V0.1 design review` 目前为 **draft，未合并**，`main` 仍停在 `5e4c23e`。
CODEX 作为 Agent-A，对其中 **Agent-B 的 Primary 区域**（`web/`）执行 §4 checklist，
重点核对三项——它们是本次审核的核心结论，如果结论本身站不住，后续里程碑全部作废：

1. `web/app/api/simulations/route.ts` 的 GET 是否真的不再写库；
2. `deriveDemoView` 是否对 `engine !== 'demo'` 的行完全不作修改
   （`web/lib/runs.ts`，对应 `web/tests/runs.test.ts` 的回归用例）；
3. `drizzle/0003` 的回填是否会丢数据，以及旧行标记为 `engine = 'demo'` 是否成立。

同时对 `docs/` 四份文档提出异议。**文档层面的分歧必须在此轮解决**——
一旦 M1 开始并行实现，架构分歧的返工成本会陡增。

### 第 2 步　双方就 §7 未决问题给出建议，由负责人决策

Q1（计算面部署在哪）与 Q2（是否有真实老化数据集）**阻塞 M1 与 M2**，
必须在第 3 步之前有答案。Q3–Q5 可以并行推进。

### 第 3 步　合并 M0，双方从同一 `main` 切出 M1 分支

此后按 §5 的「契约 → 并行实现 → 集成」节奏推进。
M1-C（契约 PR）双签合并之前，**任何一方都不得开始 M1-A / M1-B 的实现**。

### 当前实时状态（写入时点：M0 提交后）

| 项 | 状态 |
|---|---|
| `main` | `5e4c23e`，未包含本次审核 |
| PR #1 | open / draft / mergeable，2 commits，23 files |
| Python 内核 | 仍为空壳，全部实现代码仅 `__version__` 一行 |
| CI | 仍不存在（`.github/workflows/` 未建立） |
| 计算面 | 未接入，控制面全部 run 均为 `engine = 'demo'` |

此表会过期。**开工前一律以 §7 的命令重新读取，不要相信本表。**
