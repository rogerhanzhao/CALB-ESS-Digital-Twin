# Claude ↔ CODEX 双智能体协同开发与交叉审核方案

- 适用范围：`CALB-ESS-Digital-Twin` 全仓库
- 基线文档：`docs/design-review.md`（设计结论）、`docs/architecture.md`（架构）、`docs/data-model.md`（持久化契约）
- 文档状态：**评审中** — 随 PR #1 一并接受 CODEX 交叉审核（#2）。合并后生效。

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

PR #1 `V0.1 design review` 已 **ready for review，尚未合并**，`main` 仍停在 `5e4c23e`。
CODEX 作为 Agent-A，对其中 **Agent-B 的 Primary 区域**（`web/`）执行 §4 checklist，
重点核对三项——它们是本次审核的核心结论，如果结论本身站不住，后续里程碑全部作废：

1. `web/app/api/simulations/route.ts` 的 GET 是否真的不再写库；
2. `deriveDemoView` 是否对 `engine !== 'demo'` 的行完全不作修改
   （`web/lib/runs.ts`，对应 `web/tests/runs.test.ts` 的回归用例）；
3. `drizzle/0003` 的回填是否会丢数据，以及旧行标记为 `engine = 'demo'` 是否成立。

同时对 `docs/` 四份文档提出异议。**文档层面的分歧必须在此轮解决**——
一旦 M1 开始并行实现，架构分歧的返工成本会陡增。

### 第 2 步　双方就 §7 未决问题给出建议，由负责人决策

**M1 不等待任何决策。** 工程闭环可以先行，前提是替身必须是显式的：

- Q1（计算面部署在哪）——先用**可替换的本地 Docker adapter**，队列与存储走接口抽象，
  云端目标待决策后落位，不改上层代码。
- Q2（是否有真实老化数据集）——M1 用**显式标注的 synthetic fixture / stub result**。
  标注规则与 `engine = 'demo'` 一致：合成数据在库内、API 与界面上都必须自我声明，
  且不得用于质保结论。Q2 真正阻塞的是 **M2 的标定与可信 SOH 交付**。

Q3–Q5 并行推进，均不阻塞 M1。

### 第 3 步　合并 M0，双方从同一 `main` 切出 M1 分支

此后按 §5 的「契约 → 并行实现 → 集成」节奏推进。
M1-C（契约 PR）双签合并之前，**任何一方都不得开始 M1-A / M1-B 的实现**。

### 协同面（Coordination surface）

方案本身不产生协同，**工单与 CI 才产生协同**。两个智能体不共享上下文，
GitHub 是唯一的共享状态。当前工单：

| 工单 | 内容 | 责任方 | 前置 |
|---|---|---|---|
| #2 | CODEX 交叉审核 PR #1（M0） | CODEX 审 / Claude 修 | — |
| #3 | 五个待决策问题（Q1–Q5） | 项目负责人 | — |
| #4 | M1-C `contracts/` 契约 | 双方双签 | #2 |
| #5 | M1-A `compute/` 计算面骨架 | CODEX 实现 / Claude 审 | #4 |
| #6 | M1-B 控制面接队列与 R2 | Claude 实现 / CODEX 审 | #4 |
| #7 | M1-I 端到端集成与三层交叉验证 | 双方 | #5、#6 |

强制机制：

- `.github/workflows/ci.yml` —— 两个平面的 lint / 类型 / 构建 / 测试，
  外加迁移漂移检查。契约一致性 job 随 #4 落地。
- `.github/pull_request_template.md` —— §4 的 checklist 变成每个 PR 的必填项。

> 说明：`CODEOWNERS` 未采用。两个智能体都以同一个 GitHub 账号推送，
> 基于身份的强制审核在此形同虚设；所有权靠 §1 的约定与 PR 模板的声明字段维持。

### 当前实时状态（写入时点：M0 合并后）

| 项 | 状态 |
|---|---|
| `main` | `8700ba6`，已含 M0（文档、CI、PR 模板、控制面 P0 修复） |
| PR #1 | **已合并** |
| PR #8 | open / draft，`codex/m1-contract-compute`，基于合并前的 `main` |
| Python 内核 | CODEX 已提交 contracts + compute worker + SPMe runner（尚未合并） |
| CI | 已建立，`main` 上三个 job 全绿；**PR #8 尚未被 CI 覆盖** |
| 计算面 | 未接入，控制面全部 run 仍为 `engine = 'demo'` |
| 分支保护 | **未启用** —— 见 §9 |

此表会过期。**开工前一律以 §7 的命令重新读取，不要相信本表。**

---

## 9. 强制闸门（Required gates）

§1–§4 的全部规则都建立在一个前提上：**没有人绕过 PR 流程**。
目前没有任何东西保证这一点 —— `main` 的 `protected` 为 `false`，
任一方都可以把自己的 PR 直接合入，CI 红也能合。

**在启用分支保护之前，本文件描述的交叉审核只是约定，不具备否决权。**
这是整套机制最薄弱的一环，优先级高于任何里程碑。

### 9.1 需要在 `main` 上启用的设置

智能体无权配置（会话的 GitHub App token 缺 `administration` 权限，
读写分支保护均返回 403），必须由仓库管理员在
Settings → Branches → Add branch protection rule 中设置：

| 设置 | 值 | 理由 |
|---|---|---|
| Require a pull request before merging | 开 | 否则一切审核可跳过 |
| Require status checks to pass | 开 | 让 CI 具备否决权 |
| → 必选 checks | `Control plane`、`Compute plane`、`Migrations in sync` | 见 `.github/workflows/ci.yml` |
| → Require branches to be up to date | 开 | 防止基于陈旧 `main` 的分支带病合入（PR #8 即为此例） |
| Require conversation resolution | 开 | 让 review finding 必须被处理，而非被忽略 |
| Do not allow bypassing the above | 开 | 管理员不豁免，否则等于没开 |
| Allow force pushes / deletions | 关 | 保护主干历史 |

### 9.2 关于 “Require approvals” 的一个坑

**不要先开 approvals。** 两个智能体都以同一个 GitHub 账号推送，
而 GitHub **不允许作者审批自己的 PR**。若把 required approvals 设为 1，
结果不是“审核变严”，而是**所有 PR 都无法合并**。

可行路径二选一，需先验证：

1. 确认 `chatgpt-codex-connector[bot]` 提交的 review 能否算作 approval
   （它对 PR #1 提交过 review，但状态是 `commented` 而非 `approved`）。可以则设为 1。
2. 为其中一个智能体配置独立的 GitHub 身份，使双方 PR 互为不同作者。

在二者之一落实前，先只开 9.1 的设置。**status checks 与 conversation resolution
已经能挡住绝大部分问题**：CI 红不能合，finding 未处理不能合。这两条不依赖身份。

## 10. 分支与 PR 纪律

2026-08-11 夜间出现过一次失败模式,本节由它产生。当时 5 小时内新建 26 个分支/PR,而 `main`
一次都没有前进。事后用 `git merge-base --is-ancestor` 逐对验证,其中 21 个的提交**完整包含**
在同一条链的末端分支里 —— 它不是 26 项并行工作,而是**一条链上的 26 个检查点**,同一批工作
被重复提了 26 次。最终清理掉 22 个 PR,独立工作线只有 5 条。

代价是实际的:配额被耗尽,主干零推进,而 15 个分支各自携带迁移文件,一旦分别合并,序号必然
撞车 —— 而 `Migrations in sync` 只校验单分支内自洽,**发现不了跨分支冲突**。

### 10.1 一条工作线一个分支

**推进现有工作用新提交,不用新分支。**同一条工作线在被合并或被放弃之前,始终只有一个分支和
一个 PR;有了新进展就往上加提交,而不是从它再拉一个分支出来。

只有在下列情况才开新分支:

- 前一条工作线**已合并**,或
- 新工作与它**没有包含关系**,可以独立审、独立合。

判据是机械的,不靠感觉:

```
git merge-base --is-ancestor origin/<旧分支> origin/<新分支>
```

若为真,新分支包含旧分支 —— **它们是同一条线,不该有两个 PR。**

### 10.2 同一时刻的在审 PR 上限

每一方**同时最多 3 个待审 PR**。达到上限就停止开新的,先把已有的推到合并或关闭。

理由不是整洁,是**审核的有效性**:审核者的判断力是有限资源,排队越长每个 PR 得到的注意越少。
26 个 PR 的队列不会被认真审 —— 它只会被走过场,而走过场的审核比没有审核更危险,因为它会
产生"已经审过"的记录。

### 10.3 单个 PR 的规模

一个 PR 应当能被完整读完。**超过约 800 行改动(不含生成物与锁文件)就应当拆分**,拆成各自能
独立通过 CI、独立描述清楚意图的若干个。

3 万行的 PR 不存在"审过"这回事。**声称审过等于没审。**

### 10.4 迁移文件的排他性

带 `web/drizzle/` 迁移的分支**同一时刻只能有一个在审**。前一个合并后,下一个必须 rebase 到新
`main` 重新生成迁移,而不是并行准备多个。

序号冲突不会被任何现有闸门拦住,只会在合并时炸开。

### 10.5 "不停摆"不等于"不停开分支"

项目不以某个 PR 或里程碑作为停止条件。这条
成立,但它的正确形态是**把一条工作线推到合并**,不是同时开二十条。

没有可推进的工作时,合法的动作依次是:

1. 把已有 PR 推向合并(处理 finding、rebase、补测试);
2. 审核对方待审的 PR;
3. 修复已知缺陷、补测试缺口、清理技术债;
4. **等待** —— 当所有安全工作都被外部依赖或必须由 Alex.Z 作出的产品决定阻塞时。

**等待一个产品决定,优于用臆造的值把它填上。**开分支制造产出量是这条原则最容易走偏的方向,
而产出量不是进度:进度的唯一度量是 `main` 是否前进。
