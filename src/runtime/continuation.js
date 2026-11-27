import { teamAttention } from "./team.js";
import { computeNextStep } from "../state/guard.js";
import { loadCreateUserMessage } from "./host-message.js";
import { createStuckTracker } from "./stuck-detector.js";

const waiting = new Set(["REVIEW_FAILED", "REVIEW_IN_PROGRESS", "WORK_IN_PROGRESS"]);
const activePhases = new Set(["planning", "active", "reviewing"]);

function actionableStep(task) {
  if (!task || task.enabled === false || !activePhases.has(task.phase)) return null;
  const next = computeNextStep(task);
  const attention = teamAttention(task);
  if (attention?.waiting || attention?.owner === "user") return null;
  return waiting.has(next.code) ? null : next;
}

function progressFingerprint(task, next) {
  return JSON.stringify([
    task.id, task.phase, task.planVersion, next.code,
    task.continuation?.status === "requested" ? task.continuation.at : null,
    (task.nodeRuns ?? []).map(r => [r.stageId, r.attempt, r.status]),
    task.reviews?.length ?? 0,
    (task.findings ?? []).map(f => [f.id, f.status]),
  ]);
}

export function observeContinuation(ctx, registry, disposers) {
  if (typeof ctx.on !== "function") return;
  const attempts = new WeakMap();
  const stuckTrackers = new WeakMap();
  let disposed = false;
  const unsubscribe = ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
    const store = registry.all().find(s => s.get()?.mainSessionId === agent.session.id);
    const initial = store?.get();
    if (disposed || signal.aborted || store?.settings?.autoWakeMain === false) return;
    if (!initial || initial.enabled === false || !activePhases.has(initial.phase)) return;

    const { createUserMessage } = await loadCreateUserMessage();
    const task = store.get();
    if (disposed || signal.aborted || store.settings?.autoWakeMain === false) return;
    if (task?.id !== initial.id || task.mainSessionId !== agent.session.id) return;
    if (task.enabled === false || !activePhases.has(task.phase)) return;

    // v0.6：实时回合内 5 模式死循环检测（StuckDetector，在阶段执行中同样生效）
    if (store?.settings?.enableStuckDetector !== false && typeof agent.session?.snapshotEvents === "function") {
      const resumeMarker = task.continuation?.status === "requested" ? task.continuation.at : null;
      let entry = stuckTrackers.get(store);
      if (!entry || entry.taskId !== task.id || (resumeMarker && entry.resumeMarker !== resumeMarker)) {
        entry = { taskId: task.id, resumeMarker, tracker: createStuckTracker() };
        stuckTrackers.set(store, entry);
      }
      const events = agent.session.snapshotEvents() ?? [];
      const stuckRes = entry.tracker.evaluate(events);
      if (stuckRes.action === "steer" || stuckRes.action === "halt") {
        const log = [...(task.stuckEvents ?? []), {
          at: Date.now(),
          role: "main",
          pattern: stuckRes.pattern,
          action: stuckRes.action,
          repeatCount: stuckRes.repeatCount,
          evidence: stuckRes.evidence,
        }].slice(-20);
        if (stuckRes.action === "halt") {
          store.set({
            ...task,
            stuckEvents: log,
            continuation: {
              status: "needs-attention",
              kind: "stuck-detected",
              pattern: stuckRes.pattern,
              reason: stuckRes.message,
              at: Date.now(),
            },
          });
          return;
        }
        store.set({ ...task, stuckEvents: log });
        agent.steer(createUserMessage({
          source: { kind: "dsh-mentor-stuck-steer", pattern: stuckRes.pattern },
          content: [{ type: "text", text: stuckRes.message }],
        }));
        return;
      }
    }

    const next = actionableStep(task);
    if (!next) return;

    const fingerprint = progressFingerprint(task, next);
    const prior = attempts.get(store);
    const stagnant = prior?.fingerprint === fingerprint ? prior.stagnant + 1 : 0;
    const count = prior?.taskId === task.id && prior.turn === turn ? prior.count + 1 : 1;
    attempts.set(store, { taskId: task.id, fingerprint, stagnant, count, turn });

    if (stagnant >= 2 || count > 8) {
      if (task.continuation?.status !== "needs-attention") {
        store.set({ ...task, continuation: { status: "needs-attention",
          reason: "连续提示后没有实质进展，可查看问题并手动继续", at: Date.now() } });
      }
      return;
    }
    if (stagnant === 0 && task.continuation?.status === "needs-attention") {
      store.set({ ...task, continuation: null });
    }
    agent.steer(createUserMessage({
      source: { kind: "dsh-mentor-progress" },
      content: [{ type: "text", text: "[mentor] 当前任务尚未完成。" + next.text +
        " 读取 mentor_task_status；优先并行处理无依赖和写域冲突的阶段。需要用户决定时明确说明并暂停，不要虚报完成。" }],
    }));
  });
  disposers.push(() => {
    disposed = true;
    if (typeof unsubscribe === "function") unsubscribe();
  });
}
