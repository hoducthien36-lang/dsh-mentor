# dsh-mentor 行为规格（SPEC）

本文件是本项目所有实现的唯一契约来源。实现先于代码：任何未在此描述的行为都不应被实现。

---

## 0. clean-room 边界声明

### 已接触（接触面清单，逐项记录）

| 接触对象 | 内容 | 接触时间 | 影响评估 |
|---|---|---|---|
| 上游包的 `package.json` | `name` / `version` / `license` / `author` / `repository` 五个字段 | 建任务前 | 仅确认许可状态为 UNLICENSED，不含功能信息 |
| 上游仓库根目录 | 文件名列表（`.agents/ docs/ eval/ spikes/ src/` + 6 个根文件） | 建任务前 | 仅知有这些目录，未读内容 |
| 上游 `README.md` | 前 15 行 | 建任务前 | 含一句版本说明与外部链接，未读功能章节 |
| **已安装包** `~/.dsh/profiles/desktop/node_modules/dsh-task-supervisor/cordis.patch.yml` | 全文（168 B） | 建任务前 | 这是**已安装包**里的接入声明，**不是上游仓库文件**（此前清单误标为「上游」，已更正）；透露插件 id、包名、配置项名 `planningReadTools` |

### 未接触（实现期绝对禁读）

- `E:\caten\projects\dsh-task-supervisor\` 下**全部内容**，含 `source/`、`patched/`、`verification/`、`reverse-engineering/`、`packages/`、`isolated/`
- `~/.dsh\profiles\desktop\node_modules\dsh-task-supervisor\` 下**除下列两个文件之外**的全部内容：
  - 已读、不在此禁读范围：`cordis.patch.yml`（见上表）、`package.json`（只读了 name/version/license/author/repository 五字段）
  - 仍在禁读范围：`lib/`（编译产物，803.5 KB / 7 文件）、`docs/`、`README.md`、`README.zh.md`、`README.i18n.yaml`、`node_modules/`

> 更正记录：本清单初版把 `cordis.patch.yml` 误标为「上游」、并把已安装包整体列入「未接触」，与实际读取（seq 670/673）矛盾。现已按实际读取更正，并区分「上游仓库」与「已安装包」两个不同对象。

### 因接触而弃用的设计

读过上游 `cordis.patch.yml`，因此已知其配置项名为 `planningReadTools`。本项目**不沿用该命名**。

后续发展：该配置项曾以 `readOnlyToolsDuringPlanning` 的名义存在，但实现中从未有任何拦截逻辑
（配了不生效，比不提供更危险），已在 `s4` 阶段连同默认值、解析代码与文档条目一并删除。
若日后 DSH 提供可靠的工具拦截 API，再以实现 + 测试的方式重新引入。

### 审计期规则

`s6` 允许脚本自动读取上游做比对，但：

1. 只允许**脚本**读取，不允许人工阅读内容
2. 脚本只输出**数字**（相似度、重合度、计数器），不打印任何原文
3. 脚本路径与输出 JSON 必须存档留痕

---

## 1. 领域模型

### 1.1 任务（Task）

```
Task {
  id: string                    // uuid v4
  revision: integer             // 每次状态变更 +1
  objective: string             // 目标陈述
  phase: Phase                  // 见 2.1
  planVersion: integer          // 已提交计划的版本，未提交为 0
  criteria: Criterion[]
  stages: Stage[]
  nodeRuns: NodeRun[]
  findings: Finding[]
  reviews: Review[]
  createdAt: epochMs
  updatedAt: epochMs
}
```

### 1.2 阶段（Stage）与节点运行（NodeRun）

```
Stage {
  id: string                    // 短标识，如 "s1"
  title: string
  criterionIds: string[]        // 该阶段负责兑现的验收项
  dependsOn: string[]           // 前置阶段 id
  description: string
}

NodeRun {                       // 阶段的一次执行尝试
  stageId: string
  attempt: integer              // 从 1 起
  status: "pending" | "reported" | "accepted" | "rework"
  reports: StageReport[]
}
```

### 1.3 验收项（Criterion）

```
Criterion {
  id: string
  text: string
  provenance:                  // 需求来源，决定争议时以谁为准
    { kind: "user", reference: string }
  | { kind: "implementation", reference: string }
  evidenceKind: "text" | "runtime" | "visual"
}
```

`provenance.kind === "user"` 的验收项不得被实现方以「按实现调整」为由降级。来源为 `objective` 的要求一律归 `user`。

### 1.4 审查（Review）与整改（Finding）

```
Review {
  id: string
  scope: { kind: "plan" } | { kind: "stage", stageId, attempt }
  verdict: "pass" | "revise"
  findings: Finding[]
  at: epochMs
}

Finding {
  id: string
  reviewId: string
  severity: "blocking" | "advisory"
  text: string
  status: "open" | "responded" | "closed"
  responses: FindingResponse[]
  resolvedByReviewId: string | null
}

FindingResponse {
  id: string
  findingId: string
  summary: string
  evidenceIds: string[]
  at: epochMs
}
```

---

## 2. 规则

### 2.1 状态机

合法转移表（左为当前，右为允许的下一状态）：

| 当前 | 允许转移到 | 触发动作 |
|---|---|---|
| `planning` | `active` | 计划首次通过审查 |
| `planning` | `awaiting-approval` | 计划通过审查且要求人工批准（plan 审查期**停在 `planning`**，不进入 `reviewing`） |
| `planning` | `planning` | 计划被退回修改并重新提交（plan 审查 revise 的自环） |
| `active` | `reviewing` | 提交节点证据或完成请求，进入待审 |
| `reviewing` | `active` | 审查裁决为 `revise`，回到可推进状态 |
| `reviewing` | `completed` | 全部阶段被接受且无 open finding，审查裁决 pass |
| `active` | `completed` | **禁止**（必须先经 reviewing） |
| `completed` | 任意 | **禁止**（终态，只读） |

非法转移一律返回结构化错误 `E_ILLEGAL_TRANSITION`，不得静默修正。

> 2026-11-09（状态机收口）：`phase` 只有**一个写入口** —— `src/runtime/phase-writer.js` 的 `setPhase()`。
> 它内部先走 `transition()` 断言合法性再落库；任何绕过它的 phase 变更会被 store 以
> `E_PHASE_WRITE_BYPASS` 拒绝。计划审查过去把 `awaiting-approval` 直接写成 `reviewing`、
> 判 revise 时再写回 `planning`，这两条边转移表里都不存在，已全部改走合法路径：
> 计划审查期间 `phase` 保持 `planning`，审查结论由 `applyBoundReview` 落到
> `awaiting-approval` / `active`（自环 `planning`）。


### 2.2 计划 DAG 校验

提交计划时必须全部通过，任一失败则拒绝并返回具体失败项：

| 规则 | 失败码 |
|---|---|
| 每个 `stage.criterionIds` 非空，且引用的 criterion 存在 | `E_CRITERION_UNKNOWN` |
| 每个 criterion 至少被一个 stage 引用 | `E_CRITERION_ORPHAN` |
| `dependsOn` 引用的 stage 存在 | `E_DEP_UNKNOWN` |
| `dependsOn` 无环（DFS 三色标记检测） | `E_DEP_CYCLE` |
| 至少一个 stage 无依赖（有入口） | `E_NO_ENTRY` |

### 2.3 阶段验收

- 提交报告须给出 `attempt`（当前尝试号），与 `nodeRuns` 中的 attempt 不一致则 `E_STALE_ATTEMPT`
- 一个阶段只有在**其全部依赖阶段均为 `accepted`** 时才允许提交报告，否则 `E_DEP_NOT_READY`
- 审查 pass → `status = "accepted"`；审查 revise → `status = "rework"`，下次报告 attempt +1

### 2.4 整改闭环

状态推进规则，不可跳步：

```
open ──(提交 response)──> responded ──(下一次审查明确复查并通过)──> closed
        └───────────(pass 审查直接点名关闭，留 closedWithoutResponse)──────────> closed
```

- **提交响应不等于关闭**：`responded` 只是记录，finding 仍是未解决状态
- **执行方没有关闭入口**：`mentor_finding_respond` 只把状态写成 `responded`（`submitFindingResponse` 无 CLOSED 分支）
- 只有裁决为 `pass` 的审查，在 `markedResolved` 里显式点名，才允许转 `closed`；关闭动作只发生在审查方
- **2026-11-09 修订**：`pass` 可以直接关闭**本阶段**的 `open` finding（`closeFinding(finding, reviewId, { allowOpen: true })`），并写 `closedWithoutResponse: true` 留痕。原因：finding 通常在 revise 轮提出、pass 轮才关闭，跨 review；旧规则要求「必须先 responded」，导致内容已全部修复的一轮仍被打回一次、只为补一次 respond。`revise` 裁决携带 `markedResolved` 仍被拒。
- **finding id 双命名（2026-11-09）**：finding 可能以派生 id（`f_xxx_n`）存储，而审查文本里写的是 `G1`。`findingById` 采用三级解析：精确 id → 唯一别名（从 `text` 里提取的形如 `G1`/`F2` 的编号）→ 报错（带 `known` 与 `aliases`；别名多命中时带 `candidates`，不猜）。`mentor_finding_respond` 与 `mentor_review_apply` 的 `markedResolved` 都走同一解析。
- `severity === "blocking"` 的 finding 未 closed 时，任务不得进入 `completed`（`E_BLOCKING_FINDING_OPEN`）

### 2.5 完成请求

请求完成须同时满足，否则返回具体未满足项：

1. 全部 stage 的 `NodeRun.status === "accepted"`
2. 无 `status !== "closed"` 的 blocking finding
3. 最近一次审查裁决为 `pass`
4. 任务 phase 为 `reviewing`

### 2.6 报告提交门槛

`mentor_stage_report` 在写库之前必须先过两道门槛，任一不过则拒收并带明细，不得静默降级：

**门槛一：结构化证据（必填）**

`evidenceRefs[]` 必填（`mentor_stage_report` 的工具参数名），每条为片段 `{file, snippet, line?}` 或全文 `{file, scope:"file"}`，可在同一报告中混用。全文登记适用于不超过 2 MiB 的 UTF-8 文本；宿主读取并记录文本指纹。审查员判断全文性质时，须按报告编号读取对应版本直至末页。

1. 全文条目带有 `line` 或 `snippet`、片段条目缺少 `file` 或有效 `snippet`、显式给出的 `line` 非正整数、`evidenceRefs` 为空数组 → `E_EVIDENCE_REQUIRED`
2. `file` 解析后逃出项目根 → `E_EVIDENCE_OUTSIDE`
3. 省略 `line` 时必须唯一命中一行，插件回填实际行号；零命中或多行命中均拒收。显式给出 `line` 时，`snippet` 未能在该文件该行附近（±3 行窗口）逐字命中 → `E_EVIDENCE_MISMATCH`，`details.misses` 列出 `{file, line, snippet, reason}`

**门槛二：旧账与版本**

1. 任务存在 `status === "open"` 且 `responses.length === 0` 的 finding → `E_UNRESPONDED_FINDINGS`，`details.findingIds` 列出全部 id
2. `planVersion` 缺失或不等于 `task.planVersion` → `E_STALE_PLAN`，`details` 带 `expected` 与 `got`

通过后，`report` 对象必须落库 `planVersion` 与 `evidenceRefs`（供审查与回溯）。新报告同时保存引用文件的 UTF-8 文本指纹。阶段和整体验收的审查员可凭报告编号分页读取已引用文件；文本指纹变化时需要新报告，历史报告仍可按原有引用复核。

---

## 3. 错误约定

所有对外工具的错误统一形状：

```
{ ok: false, code: "E_...", message: string, details?: object }
```

禁止抛裸异常到工具边界。错误码清单见第 2 节各表。

报告提交门槛（§2.6）相关错误码：

| 码 | 触发 | details |
|---|---|---|
| `E_EVIDENCE_REQUIRED` | `evidence` 缺失/空数组/条目缺字段 | `index`, `missing` |
| `E_EVIDENCE_MISMATCH` | snippet 未命中 / 文件不存在 / 行号越界 | `misses[]` |
| `E_EVIDENCE_OUTSIDE` | `file` 逃出项目根 | `file` |
| `E_UNRESPONDED_FINDINGS` | 存在 open 且未响应的 finding | `findingIds[]` |
| `E_STALE_PLAN` | `planVersion` 缺失或不等于当前 | `expected`, `got` |
| `E_PHASE_WRITE_BYPASS` | 同一条任务的 `phase` 被改写但没有走 `setPhase()`（`phaseWriter` 标记缺失） | `taskId`, `from`, `to`, `hint` |

---

## 4. 工具接口（对外契约）

本项目向 DSH 注册以下工具。参数与返回值以本节为准。

| 工具名 | 作用 | 关键入参 | 关键出参 |
|---|---|---|---|
| `mentor_task_create` | 建任务 | `objective`, `userMessageSeq?` | `taskId`, `phase` |
| `mentor_task_status` | 读状态 | `taskId?`, `findingId?` | 完整快照或指定 finding |
| `mentor_plan_submit` | 提交计划 | `taskId`, `criteria[]`, `stages[]` | `planVersion`, `validation` |
| `mentor_stage_report` | 上报节点 | `taskId`, `stageId`, `attempt`, `evidence`（散文摘要）, `evidenceRefs[]`（必填，`{file,line?,snippet}` 或 `{file,scope:"file"}`）, `planVersion`（必填） | `status`, `reviewQueued`, `evidenceRefs` |
| `mentor_completion_request` | 请求完成 | `taskId`, `evidence` | `accepted?`, `unmet[]` |
| `mentor_finding_respond` | 响应整改 | `taskId`, `findingId`, `summary`, `evidenceIds[]` | `findingStatus` |
| `mentor_review_apply` | 应用审查裁决 | `taskId`, `stageId`, `attempt`, `verdict`, `findings[]`, `markedResolved[]` | `reviewId`, `verdict`, `phase`, `unresolved` |

### §4.1 `taskId` 的语义

所有工具都接受 `taskId`，但本实现的状态存储是**单任务**的：

- `taskId` 是可选**校验参数**：传了就核对是否与当前任务一致
- 不一致时返回结构化错误（`details` 带 `requestedTaskId` / `currentTaskId` / `multiTask:false`），**不静默忽略**
- 缺省时用当前任务

多任务存储只需替换 store 实现，handler 签名不变。

### §4.2 关于 `mentor_review_apply`

本节初版只列了 6 个工具，漏掉了审查裁决入口。但审查是整改闭环的必需环节——没有它，`stage_report` 之后流程无法推进、`finding` 永远停在 `responded`。故补入第 7 个工具，并明确两者分工：

- `mentor_review_apply` **产生**裁决（写入 review 与 findings，推进 nodeRun 状态）
- `mentor_completion_request` **消费**裁决（检查是否已满足完成条件）

### §4.3 `reviewQueued` 的语义（2026-11-09 修订）

- `reviewQueued` 必须等于真实派发结果：`value.reviewQueued === value.reviewDispatch.queued`。
- handler 层**不再返回常量 `true`** —— handler 不知道派发成败，常量会在派发失败时
  与 `reviewDispatch.queued=false` 自相矛盾（R-02）。
- `mentor_stage_report` 的出参同时包含 `evidenceRefs`（本报告落库的结构化证据）。
- `mentor_plan_submit` / `mentor_plan_amend` 在检查点审查开启时：`phase` 返回 `planning`，
  `reviewPending: true`，`reviewQueued` 同样来自实际派发结果。

### §4.4 `mentor_task_status` 的读通道（2026-11-09 新增）

真机事故：任务快照约 140KB 时，宿主对工具输出只保留首尾、截掉中段（`Omitted ~100KB`），而 `nodeRuns.reports` 是追加式排列，新报告必然落在被截掉的区段；审查侧又没有 `read`/`bash` 可用，只有这个快照 —— 于是「证据写得再全也读不到」。为此增加三条读通道：

| 入参 | 语义 |
|---|---|
| `reportId` | **只回这一条报告全文**（`reportOnly: true`，不附带整快照，故输出必然短、绕开截断）；找不到时回 `found: false` + `knownReportIds` |
| `stageId` | 只回该阶段的 `nodeRuns` / `reviews` / `findings` / reviewer participants，并回带 `stageFilter` |
| `limit` | 每阶段回最近 N 条报告（默认 3），单条 `evidence` 只截前 4000 字符，并标 `evidenceTruncated` 与 `evidenceLength` |

返回体固定附带 `reportTotal`（报告总数）与 `reportsTruncated`（是否发生分页），调用方据此判断有没有被裁剪。`buildStatePayload`（面板 RPC）的契约不变。

### §4.5 worker 越界工具看门狗（2026-11-09 新增）

`restrictMentorChild` 在 allow 全为内置工具时会降级成 `mode="builtin-unrestricted"`（宿主 `tools.restrict` 只认全局工具），worker 实际拿到全量工具，仅剩 prompt 约束。为此在 `dispatchWorkers` 里加运行时看门狗：每 1.5 秒扫一次 `snapshotEvents()`，命中 `bash` / `team_task_*` / `spawn_teammate` / `send_message` / `wait_agent` / `list_agents` / `interrupt_agent` / `task_*` / `ego_*` / `mcp__*` 即写 `recordRuntimeWorker({status:"failed", error:"worker-forbidden-tool:<name>"})` 并中止该 worker。判定与轮询在 `src/review/worker-policy.js`（可注入，单测覆盖到接线）。写域仍由 `writeGuard` + `stage.writePaths` 负责，不在本看门狗范围内。

---

## 5. 持久化

- 状态文件路径由插件配置项 `stateDir` 决定，默认 `<dshHome>/mentor/`
- 写入必须原子：写 `.tmp` → fsync → rename，避免半截文件
- 读取到损坏文件时不得静默重建：先移入 `quarantine/` 再新建，并记录警告
- 每次状态变更 `revision` +1，写入前后 revision 不连续视为并发写冲突，返回 `E_REVISION_CONFLICT`

---

## 6. 配置项

| 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `stateDir` | string | `""`（用默认） | 状态文件目录 |
| `requireEvidenceForPass` | boolean | `true` | 审查 pass 前是否强制要求证据引用 |

> **已移除：`readOnlyToolsDuringPlanning`**
> 该配置项曾声明「规划阶段仅允许只读工具」，但实现里从未有任何拦截逻辑 ——
> 配了不生效，比不提供更危险。已连同默认值、解析代码与本文档条目一并删除。
> 若日后 DSH 提供可靠的工具拦截 API，再以实现 + 测试的方式重新引入。


### 2026-11-13：整改复核与人工出口补充

- revise 可用 existingFindingIds 引用本次审查范围内尚未关闭的问题；不再强制每轮新增 finding。相同阶段、相同严重度且文本完全相同的未解决问题复用旧编号。不会自动合并语义近似但不同的问题。
- pass 仍须显式 markedResolved，不能同时声明未解决的 existingFindingIds。计划和整体验收也允许独立 reviewer 显式复核关闭 open 问题，记录 closedWithoutResponse；响应仍不等于关闭。
- 整体验收可复核阶段问题，但只限当前计划下已 accepted 阶段：checks[].findingIds 必须包含该问题真实编号，reportIds 必须包含该阶段当前报告编号，对应检查须覆盖该阶段全部验收项。审查记录保存 stageFindingRechecks；证据过期或缺失则拒绝关闭。
- 整体验收仍检查全部未关闭的 blocking，包括本轮新增问题。不得通过排除阶段问题、排除新增问题或自动关闭 responded 来绕过验收。
- /mentor close <问题编号> <理由> 是人工强制关闭入口，记录 closedBy=user、理由及时间。mentor_finding_close 不注册为模型工具，适配层也拒绝非人工调用。
- 审查失败后，同一 kind/stage/attempt/planVersion 最多自动通知主会话一次；失败详情及投递结果保存在 job。后续失败保留面板提示，不形成无限通知重试链。关闭 autoWakeMain 时只保留提示。
- 恢复函数仅在确有在途审查、执行节点或委派时更新 revision/updatedAt。无在途工作且超过 24 小时无状态更新的活跃任务显示只读提醒，不自动归档。
