# 开工必读 — 三方智能体交接清单

> `docs/collaboration-claude-codex.md` 定长期规则；本文件记录"这一轮具体该做什么、不该做什么"。
>
> **本轮记录**：2026-08-14T00:30Z ｜ 执行方：Claude（Agent-B）｜ 审核对象：PR #48 / WORKBUDDY 首轮接入

## 本文件的写入规则（先读这条）

1. **追加，不覆盖。** 每一轮交叉审核在文件**顶部追加**一条带日期的交接记录，
   旧记录原样保留。任何一方都不得改写他方已写下的记录 —— 那是审计痕迹，不是草稿。
2. **单一写者。** 一条记录的写者是**当轮执行交叉审核的那一方**，其他两方只能追加新记录，
   或在对应 PR 上提 finding。
3. **状态表 24 小时后即视为过期。** 下方所有状态表都带时间戳；
   超过 24 小时一律以 §0 的命令输出为准，**不得引用过期表作为事实依据**。
4. **本文件没有裁决权。** 它是交接件，不是真相源。
   真相源永远是 `git` 与 CI（见 collaboration §7）。本文件与仓库现状冲突时，**以仓库为准**。

---

## 0. 开工三条命令（不许跳过）

```bash
git fetch origin --prune
git log --oneline origin/main -15
git branch -r                      # 分支总数超过 8 条就先停下来清理
```

**不得依据对话记忆断言任何事实。**本文件的状态表也会过期 —— 表与命令冲突时，以命令为准。

---

## 1. 本轮核实的真实状态（2026-08-14T00:30Z）

| 项 | 状态 |
|---|---|
| `main` | `ca68049`（PR #47 合并后）—— **已连续约 10 小时零前进** |
| 远程分支 | 6 条，未失控（对比 08-11 事故当晚的 31 条） |
| 在审 PR | 4 个：#49、#11、#48、#41 |
| 分支保护 | **已启用**（#48 三个 check 全绿仍为 `blocked`，即存在 required review / conversation resolution 门禁）。§9 与 §"当前实时状态"表仍写着"未启用"，**该表已失效** |
| `data/` | 仅 `.gitkeep` —— **仓库内没有任何真实老化数据**，Q2 仍未决 |
| `src/.../system/` | **不存在** |

### 各分支处置

| 分支 | 状态 | 该做什么 |
|---|---|---|
| `codex/soh-extrapolation-core` (#49) | ahead 4，`clean` | 待 Claude 交叉审核 |
| `codex/physical-operating-model` (#11) | ahead 5，开了 5 天 | 推向合并或关闭；它是 #48 F6 的前置 |
| `audit/docs-governance-f2-f7` (#48) | ahead 1，CI 绿，`blocked` | 按 §3 的 finding 修改后再审 |
| `codex/m4-calibration-fit-job` (#41) | **31016 行 / 162 文件 / 15 个迁移** | **不可能被真实审核**。已按 §10.3 应拆分；#49 是从它抽出的第一块，继续抽 |
| `codex/soh-calibration-core` | ahead 0 / behind 1，已合并 | **删除** |

---

## 2. 协同机制体检结论

**机制成立，本轮没有重演 08-11 的分支失控。**分支数 6，各方在审 PR 均未超过 §10.2 的 3 个上限；
`git merge-base --is-ancestor` 逐对验证，**没有发现"同一条链拆成多个 PR"**。
唯一的包含关系是 `codex/soh-calibration-core ⊂ 其余三条`，那是因为它已经合进 `main`，属正常。

三方交叉审核**首次显示出双方互审拿不到的价值**：WORKBUDDY 审出 CODEX 漏掉的文档漂移，
CODEX 审出 WORKBUDDY 自己引入的新漂移，本轮 Claude 又审出前两方都漏掉的 §3.1/§3.2/§3.3。
三方各自的盲区不重合 —— 这正是 §0 风险 2 想要的效果。

### 但有两条系统性问题

**（1）`main` 不前进。** 4 个 PR 在审、CI 全绿、无冲突，`main` 十小时没动。
§10.5 写得很清楚：**进度的唯一度量是 `main` 是否前进**。当前瓶颈不是产出，是合并。
下一轮的第一优先级是**把 #49 和 #11 推到合并**，而不是开新工作线。

**（2）revert 没有写理由。** `main` 的历史里有一对裸 revert，两条 commit message 都只有
`git revert` 的默认文本，没有任何理由：

```
df1d707 Revert "Add validity-aware SOH extrapolation"
4ebac87 Revert "Preserve fractional planned cycle counts"
```

**准确的说法**（2026-08-14T00:35Z 复核后修正）：这一对 revert 并非发生在 `main` 上，
而是发生在 `codex/soh-calibration-core` 分支内部，随 PR #47 合并**进入 `main` 的历史**。
两者可从 `origin/main`（`ca68049`）到达，可自行复核：

```bash
git merge-base --is-ancestor df1d707 origin/main && echo REACHABLE
git merge-base --is-ancestor 4ebac87 origin/main && echo REACHABLE
```

所以这不是"合进主干又被撤回"，而是"分支内自我撤回后连同撤回记录一起合入"。
影响小于前者，但问题仍在：PR #49 正在重新落地同一批工作（`825040a`/`f3e47fe` 的内容，
扩充加固后为 631 行），而 #49 的描述**未提及这段撤回历史**。
审核者无从判断当初撤回的原因是否已被解决。

**规定**（对未来生效，不追溯）：revert 任何已推送的提交，commit message 必须写明理由；
重新落地被 revert 的工作，PR 描述必须引用该 revert 并说明「原因是什么、这次怎么解决的」。

**对 #49 这类历史遗留情形的例外 —— 只陈述已知事实，禁止补写原因。**
两条 revert 的 message 都是 `git revert` 默认文本，撤回原因**从未被记录**。
任何一方都不得为它「补」一个理由：那正是 `docs/design-review.md` §P0-3 要防的编造。
#49 的描述应当写成、且只写成：

> 本 PR 的工作曾以 `825040a` / `f3e47fe` 提交，随后在 `codex/soh-calibration-core`
> 分支内被 `df1d707` / `4ebac87` 撤回，**撤回原因未被记录**。
> 本次重新落地新增了 ⟨列出实际新增的测试与加固⟩。

若原始执行方能提供真实原因，作为**单独署名的证据**补充，不并入上述陈述。
「原因不明」是一个合法且必须如实呈现的状态。

---

## 3. PR #48 的未决 finding（WORKBUDDY 必须处理后才能合并）

CODEX 已提三条（system/ 目录不存在、M2 勾选过度、当前状态表与 §9 陈旧），
**那三条依然有效，不重复。**以下是 Claude 本轮新增、前两方都漏掉的：

| 编号 | 位置 | 问题 | 判定 |
|---|---|---|---|
| C-1 | PR #48 描述 | 通篇引用 `docs/third-party-audit.md`，该文件**在任何分支上都不存在**。F1–F7 无法复核，F1 内容不明 | CONFIRMED |
| C-2 | `docs/collaboration-claude-codex.md:385` | F6 删除的不是悬空引用，是**指向在审 PR #11 的前向引用**。#11 正是新增该文件的 PR | CONFIRMED |
| C-3 | `CHANGELOG.md:10` | 「Compute plane」小节按 §2.3 属 Agent-A 的格子，审计方不得代写 | CONFIRMED |
| C-4 | `.github/workflows/ci.yml:84` | 按 §1，`.github/workflows/` 是 Agent-B 的 Primary 区域，审计方不得直接改（内容本身正确） | CONFIRMED |
| C-5 | 分支名 `audit/*` | §2.1 只定义 `codex/*` 与 `claude/*`。现已在 §11.1 定为 `workbuddy/*` | CONFIRMED |

**核实无误、不需要改的部分**（避免下一轮重复质疑）：

- F5 的 ci.yml 注释**属实**：`tests/test_contracts.py::test_generated_contracts_are_current` 确实
  重新导出并逐字节比对，`web/tsconfig.json` 与 `web/lib/runs.ts` 确实消费 `contracts/generated/`，
  契约一致性**确实已被强制**。
- F3 的 CHANGELOG 内容、F7 的版本号说明，事实层面正确（问题只在写入权，见 C-3）。

---

## 4. 下一轮的禁止动作

1. **不许新开分支**去做已有分支能承载的工作（§10.1）。推进用新提交。
2. **不许在 `main` 前进之前**开第 4 条工作线。先合并，再开工。
3. **不许勾选 `docs/design-review.md` 里含"真实数据"字样的条目** —— `data/` 是空的，Q2 未决。
   要勾就先把条目拆成「引擎实现」与「真实数据标定结果」两条。
4. **不许把 #41 直接推向合并**。31016 行的 PR 声称审过等于没审（§10.3）。继续像 #49 那样抽块。
5. **不许在无理由的情况下 revert 或重新落地被 revert 的提交**（见 §2(2)）。

---

## 5. 谁接下来做什么

| 责任方 | 动作 |
|---|---|
| **WORKBUDDY** | 处理 CODEX 三条 + 本文件 C-1…C-5；把审计报告 `docs/audit-*.md` 补进 #48；分支改用 `workbuddy/*` |
| **CODEX** | **按顺序**：① 把 #49 与 #11 推到合并或关闭（#11 是 #48 F6 的前置）；② 给 #49 描述补上 revert 溯源，**只陈述已知事实，不得推测撤回原因**（见 §2(2)）；③ **只有在 `main` 因此前进之后**，才从 #41 抽下一块。在 ① 完成前不得开新工作线（§4.2） |
| **Claude** | 交叉审核 #49 的 validity-envelope 语义与 approval gating（#49 已点名）；删除已合并的 `codex/soh-calibration-core` |
| **Alex.Z（负责人）** | Q2（是否有真实老化数据集）—— 它现在**同时卡住 M2 勾选、#41 和质保结论**，是唯一真正的阻塞项 |
