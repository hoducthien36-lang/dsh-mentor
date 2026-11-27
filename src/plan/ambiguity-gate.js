/**
 * 模糊需求前置澄清 / 弃权门（Ambiguity & Abstention Gate，v0.6）。
 *
 * 理论依据：Ask or Assume? (arXiv:2603.26233, EMNLP 2026) & AgentAbstain (arXiv:2607.10059, NeurIPS 2026)
 *   - 把「识别需求欠规格/自相矛盾」与「写代码执行」解耦；
 *   - 仅在发现真实歧义、破坏性未定界或约束冲突时，提出最多 3 条紧凑结构化选择题；
 *   - 绝不对清晰、具体的任务制造无意义的“企业剧场”式盘问。
 *
 * 零外部依赖、纯确定性 <2ms。
 */

export const AMBIGUITY_CATEGORIES = Object.freeze({
  CONTRADICTORY_CONSTRAINTS: "CONTRADICTORY_CONSTRAINTS",
  DESTRUCTIVE_UNSCOPED: "DESTRUCTIVE_UNSCOPED",
  VAGUE_OBJECTIVE: "VAGUE_OBJECTIVE",
  UNVERIFIABLE_CRITERIA: "UNVERIFIABLE_CRITERIA",
  UNSCOPED_MULTI_STAGE: "UNSCOPED_MULTI_STAGE",
});

const DESTRUCTIVE_RE = /(?:删除全部|清空|彻底删除|批量删除|重做整个|重写整个|迁移数据库|删库|覆盖历史|drop\s+table|truncate\s+table|delete\s+all|wipe\s+out|force\s+push|reset\s+--hard)/iu;
const SCOPE_GUARD_RE = /(?:只限|仅限|保留|备份|回滚|不包含|排除|dry[\s-]?run|staging|测试环境|目录|文件|\.[a-z]{1,5}\b|[\\/])/iu;

const VAGUE_ONLY_RE = /^(?:请)?(?:帮我)?(?:优化一下|改进一下|改善一下|改善体验|重构一下|修一下|修复一下|搞定一下|处理一下|提升性能|清理一下|整理一下|make\s+it\s+better|improve\s+(?:this|it|performance)|fix\s+(?:it|bugs)|clean\s+up|refactor\s+it)[。！!?.？\s]*$/iu;
const CONCRETE_ANCHOR_RE = /(?:[a-z0-9_-]+\.[a-z0-9]{1,6}|\/[a-z0-9_.-]+|\b(?:api|rpc|sql|json|css|html|http|cli|ui|bug|test|stage|diff|mcp|git)\b|函数|接口|按钮|字段|报错|端口|测试|文件|模块|状态|命令|配置|日志|脚本)/iu;

const VAGUE_CRITERION_RE = /^(?:代码)?(?:更好|更清晰|更优雅|更稳定|更流畅|体验更好|正常|没问题|可用|完成|通过|works\s+well|looks\s+good|clean\s+code|improved|done)[。！!?.？\s]*$/iu;

const CONTRADICTION_PAIRS = [
  {
    id: "readonly-vs-write",
    a: /(?:严格只读|严禁修改任何文件|不得修改代码|read[\s-]?only\s+only|do\s+not\s+modify\s+files)/iu,
    b: /(?:修改代码|写入文件|重构|实现新功能|删除文件|write\s+files|modify\s+code)/iu,
    question: "目标中同时出现了「只读/不改文件」和「修改/写入代码」约束，请确认本次允许的操作边界？",
    options: ["仅做只读分析并输出方案（不改磁盘）", "允许修改指定文件（放开只读限制）", "先只读调研，确认后再开启写入"],
  },
  {
    id: "no-dep-vs-install",
    a: /(?:零外部依赖|零依赖|禁止引入第三方依赖|不新增依赖|zero\s+dependencies|no\s+external\s+dependencies)/iu,
    b: /(?:npm\s+install|yarn\s+add|pnpm\s+add|pip\s+install|安装第三方包|引入\s+\w+\s+库)/iu,
    question: "目标同时要求「零外部依赖」与「安装/引入外部包」，请确认优先遵守哪一条？",
    options: ["严格零外部依赖，用内置能力独立实现", "允许引入指定第三方包（放弃零依赖要求）"],
  },
  {
    id: "no-breaking-vs-rename",
    a: /(?:不破坏兼容|严禁改动现有接口|保持\s*api\s*完全不变|backward[\s-]?compatible|no\s+breaking\s+changes)/iu,
    b: /(?:删除旧接口|重命名公开\s*api|破坏性重构|remove\s+public\s+api|breaking\s+change)/iu,
    question: "目标同时要求「保持接口完全兼容」与「删除/重命名公开接口」，请确认兼容策略？",
    options: ["保留旧接口作为兼容别名（无破坏变更）", "接受破坏性变更并同步更新所有调用方"],
  },
];

function answeredSet(clarifications) {
  const out = new Set();
  for (const item of Array.isArray(clarifications) ? clarifications : []) {
    if (typeof item === "string" && item.trim()) out.add(item.trim());
    else if (item && typeof item === "object") {
      if (typeof item.id === "string" && item.id.trim() && String(item.answer ?? "").trim()) {
        out.add(item.id.trim());
      }
      if (typeof item.category === "string" && item.category.trim() && String(item.answer ?? "").trim()) {
        out.add(item.category.trim());
      }
    }
  }
  return out;
}

/**
 * 分析任务目标与计划的歧义、缺口与冲突，输出最多 3 条紧凑澄清问题。
 *
 * @param {{
 *   objective?: string,
 *   stages?: Array<object>,
 *   criteria?: Array<object>,
 *   clarifications?: Array<string|{id?:string, category?:string, answer?:string}>,
 * }} params
 */
export function analyzePlanAmbiguity({
  objective = "",
  stages = [],
  criteria = [],
  clarifications = [],
} = {}) {
  const obj = String(objective ?? "").trim();
  const stageList = Array.isArray(stages) ? stages.filter(Boolean) : [];
  const criteriaList = Array.isArray(criteria) ? criteria.filter(Boolean) : [];
  const answered = answeredSet(clarifications);
  const fullText = [obj, ...criteriaList.map((c) => String(c?.text ?? ""))].join("\n");

  const questions = [];
  const pushQ = (q) => {
    if (questions.length >= 3) return;
    if (answered.has(q.id) || answered.has(q.category)) return;
    questions.push(q);
  };

  // 1. 显式约束自相矛盾（最高严重度：建议先弃权/澄清）
  for (const pair of CONTRADICTION_PAIRS) {
    if (pair.a.test(fullText) && pair.b.test(fullText)) {
      pushQ({
        id: `clarify-${pair.id}`,
        category: AMBIGUITY_CATEGORIES.CONTRADICTORY_CONSTRAINTS,
        severity: "blocking",
        question: pair.question,
        options: pair.options,
      });
    }
  }

  // 2. 破坏性/不可逆意图但缺少范围或保护边界（严禁仅凭模型在 stages 里塞任意 writePaths 绕过）
  if (DESTRUCTIVE_RE.test(obj) && !SCOPE_GUARD_RE.test(obj)) {
    pushQ({
      id: "clarify-destructive-scope",
      category: AMBIGUITY_CATEGORIES.DESTRUCTIVE_UNSCOPED,
      severity: "blocking",
      question: "任务包含破坏性/不可逆操作，但未明确作用范围与保护边界，请确认执行策略？",
      options: [
        "仅在指定目录/表内执行，并先做可回滚快照",
        "先做演练/预览清单（不实际删除），确认后再执行",
        "取消破坏性操作，改为安全增量改造",
      ],
    });
  }

  // 3. 过于宽泛且无任何具体锚点的模糊目标
  if (
    obj.length > 0 &&
    (VAGUE_ONLY_RE.test(obj) || (obj.length < 14 && !CONCRETE_ANCHOR_RE.test(obj) && criteriaList.length === 0))
  ) {
    pushQ({
      id: "clarify-vague-objective",
      category: AMBIGUITY_CATEGORIES.VAGUE_OBJECTIVE,
      severity: "advisory",
      question: `当前目标「${obj.slice(0, 40)}」较宽泛且缺少可核验落点，优先聚焦哪一类交付？`,
      options: [
        "修复明确可复现的缺陷（提供复现步骤与回归测试）",
        "优化指定模块性能/结构（限定改动文件范围）",
        "先输出诊断报告与候选方案，确认后再改代码",
      ],
    });
  }

  // 4. 验收项全部/大部为主观空话、不可核验
  if (criteriaList.length > 0) {
    const vagueCriteria = criteriaList.filter((c) => {
      const t = String(c?.text ?? "").trim();
      return !c?.observe && (t.length < 6 || VAGUE_CRITERION_RE.test(t));
    });
    if (vagueCriteria.length > 0 && vagueCriteria.length * 2 >= criteriaList.length) {
      pushQ({
        id: "clarify-unverifiable-criteria",
        category: AMBIGUITY_CATEGORIES.UNVERIFIABLE_CRITERIA,
        severity: "advisory",
        question: `计划中有 ${vagueCriteria.length}/${criteriaList.length} 条验收项偏主观（如「${String(vagueCriteria[0]?.text ?? "").slice(0, 20)}」），希望采用哪种客观验收方式？`,
        options: [
          "补齐可执行的单元测试/命令断言",
          "按具体文件改动与输入输出样例逐项核验",
          "由人工在交付后最终确认",
        ],
      });
    }
  }

  // 5. 多阶段计划但多个阶段未声明 writePaths（极易出现范围漂移与写域碰撞）
  if (stageList.length >= 2) {
    const missingPaths = stageList.filter((s) => !Array.isArray(s?.writePaths) || s.writePaths.length === 0);
    if (missingPaths.length >= 2) {
      pushQ({
        id: "clarify-stage-write-paths",
        category: AMBIGUITY_CATEGORIES.UNSCOPED_MULTI_STAGE,
        severity: "advisory",
        question: `多阶段计划中有 ${missingPaths.length} 个阶段未声明改动文件范围（writePaths），是否先限定写域？`,
        options: [
          "为各阶段补齐精确 writePaths 以启用严格越界审计",
          "这些阶段为只读调研/验证，无需写入代码",
        ],
      });
    }
  }

  const blocking = questions.some((q) => q.severity === "blocking");
  const hasContradiction = questions.some((q) => q.category === AMBIGUITY_CATEGORIES.CONTRADICTORY_CONSTRAINTS);
  const abstainRecommended = hasContradiction || (blocking && questions.length >= 2);
  const score = Math.min(
    100,
    questions.reduce((acc, q) => acc + (q.severity === "blocking" ? 45 : 22), 0),
  );

  return {
    hasAmbiguity: questions.length > 0,
    blocking,
    abstainRecommended,
    score,
    questions,
    summary: questions.length === 0
      ? "需求与验收边界清晰，无需额外澄清。"
      : blocking
        ? `检测到 ${questions.length} 项高风险歧义/约束冲突，建议先澄清或暂缓执行。`
        : `检测到 ${questions.length} 项待确认细节，建议在推进前补充边界。`,
  };
}

/** 格式化为可读 Markdown（用于 `/mentor clarify` 与审查员提醒）。 */
export function formatClarificationMarkdown(report) {
  if (!report || !report.hasAmbiguity) {
    return "当前任务需求与验收边界清晰，无待澄清项。";
  }
  const lines = [
    `【前置澄清门】${report.summary}${report.abstainRecommended ? "（建议先弃权暂缓实施，待确认后再推进）" : ""}`,
  ];
  for (let i = 0; i < report.questions.length; i += 1) {
    const q = report.questions[i];
    const badge = q.severity === "blocking" ? "[阻断]" : "[建议]";
    lines.push(`${i + 1}. ${badge} (${q.id}) ${q.question}`);
    for (let j = 0; j < (q.options ?? []).length; j += 1) {
      lines.push(`   ${String.fromCharCode(65 + j)}. ${q.options[j]}`);
    }
  }
  lines.push("回复方式：/mentor clarify <问题ID> <你的决定>");
  return lines.join("\n");
}
