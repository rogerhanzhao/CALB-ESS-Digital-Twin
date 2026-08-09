<!--
本模板是 docs/collaboration-claude-codex.md §4 的执行面。
Primary（实现方）填写上半部分，Reviewer（审核方）填写下半部分。
Reviewer 不得直接修改 Primary 区域的实现代码，只能提 finding 或补测试。
-->

## 变更内容

<!-- 做了什么，以及为什么。若对应某个里程碑，注明 M 编号（见 docs/design-review.md §5）。 -->

## 所有权

- 里程碑 / 编号：
- Primary（实现）：<!-- Agent-A (CODEX) / Agent-B (Claude) -->
- Reviewer（审核）：
- 本 PR 是否触碰了对方 Primary 区域的文件：<!-- 否 / 是（说明原因，原则上应拆 PR） -->

## 新增依赖

<!-- 逐条列出并说明必要性。无则填「无」。 -->

## 验证方式

<!-- 本地实际跑过什么。CI 之外的手工验证也写清楚。 -->

---

## Reviewer Checklist

回归防线 —— 以下六条对应 V0.1 已经发生过的问题，**不得跳过**：

- [ ] 未引入硬编码 / 编造的指标或示例数值（design-review §P0-3）
- [ ] 读路径（GET / 查询）不写库（§P0-2）
- [ ] 伪实现或占位逻辑已明确标记（`engine = 'demo'` 或等价物），不会被误认为真实结果（§P0-2）
- [ ] 已记录 provenance：`model_version` / `code_revision` / `cell_param_set_version`（§P1-2）
- [ ] 越过 validity envelope 的运行已被标注（architecture.md §3）
- [ ] `warranty` 未绕过 `system` 折算层直接读取电芯级 SOH（§P0-4）

通用：

- [ ] 输入显式校验并返回 4xx，而非静默钳制（§P1-3）
- [ ] 写入字段只由 data-model.md 指定的唯一写者写入
- [ ] 不确定度已声明来源（architecture.md §5）
- [ ] 新增依赖必要且已说明
- [ ] 有对应的 golden case 或属性测试（collaboration §3 L2 / L3）

Finding 格式统一为 `文件:行号 — 问题 — 建议`，
已验证的标 `CONFIRMED`，不确定的标 `PLAUSIBLE`。
