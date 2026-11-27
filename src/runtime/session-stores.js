import { createHash } from "node:crypto";
import { readdir, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { calibrateWork } from "./work-history.js";
import { writeState } from "../persist/store.js";
import { queryAcceptedLessons, listProjectLessons, loadProjectLessons, normalizeProjectKey, sanitizeLessonText, lessonFingerprint, recordLessonFeedback } from "./lessons.js";

export async function createSessionStores(factory, config) {
  const stores = new Map();
  const creating = new Map();
  let closing = false;
  const legacy = await factory(config.stateDir);
  let selected = legacy;
  const applySettings = (store) => {
    store.settings = Object.freeze({ ...config, requireCheckpointReviews: true });
    store.shuttingDown = closing;
    return store;
  };
  applySettings(legacy);
  stores.set("legacy", legacy);
  const base = config.stateDir ? path.join(config.stateDir, "sessions") : null;
  if (base) {
    await mkdir(base, { recursive: true });
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name)) stores.set(entry.name, applySettings(await factory(path.join(base, entry.name))));
    }
  }
  // v0.4 防脑裂：若崩溃导致同一 task.id 落在多个会话目录，启动期按 (ownershipGeneration, revision, updatedAt) 保留最新一份并清理旧副本
  const byTaskId = new Map();
  const rank = (t) => [Number.isInteger(t?.ownershipGeneration) ? t.ownershipGeneration : 0, Number(t?.revision) || 0, Number(t?.updatedAt) || 0];
  const isNewer = (a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) { if (ra[i] !== rb[i]) return ra[i] > rb[i]; }
    return false;
  };
  for (const s of new Set(stores.values())) {
    const t = s.get();
    if (!t?.id) continue;
    const prev = byTaskId.get(t.id);
    if (!prev) { byTaskId.set(t.id, s); continue; }
    if (isNewer(t, prev.get())) {
      prev.clear?.();
      byTaskId.set(t.id, s);
    } else {
      s.clear?.();
    }
  }
  const all = () => [...new Set(stores.values())];
  const taskStore = (id) => all().find(s => s.get()?.id === id);
  const findSession = sessionId => all().find(s => {
      const t = s.get();
      return t && (t.mainSessionId === sessionId || t.reviewJobs?.some(j => j.sessionId === sessionId) || t.nodeRuns?.some(r => r.workerSessionId === sessionId));
    });
  const forSession = async (sessionId) => {
    if (closing) throw new Error("插件正在卸载，不能创建或选择会话");
    if (!sessionId) throw new Error("当前操作缺少宿主会话身份");
    const found = findSession(sessionId);
    if (found) { selected = found; return found; }
    const key = createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
    if (!stores.has(key)) {
      if (!creating.has(key)) creating.set(key, factory(base ? path.join(base, key) : "").then(applySettings).then(s => { stores.set(key, s); return s; }).finally(() => creating.delete(key)));
      await creating.get(key);
    }
    selected = stores.get(key);
    return selected;
  };
  // 2026-11-13 修：tasks 列表不过滤终态，导致面板把早已归档的任务（含其停在 rework 的阶段进度）
  // 当成进行中的任务一直显示。归档 = 不再关心，从 summaries 里剔除；all()/select()/get() 不受影响，
  // 归档任务仍可按 id 选中与读取。
  const summarize = () => all().map(s => s.get()).filter(t => t && t.phase !== "archived").sort((a,b) => b.updatedAt-a.updatedAt).map(t => ({ taskId:t.id, mainSessionId:t.mainSessionId??null, objective:t.objective, phase:t.phase, revision:t.revision }));
  async function projectHistory(current) {
    if (!current.workspaceRoot) return [];
    const rootKey = value => {
      const resolved = path.resolve(value);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const root = rootKey(current.workspaceRoot);

    const candidates = all().map(store => store.get());
    if (config.stateDir) {
      const dir = path.join(config.stateDir, "history");
      try {
        const names = (await readdir(dir, { withFileTypes: true }))
          .filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name));
        const files = await Promise.all(names.map(async entry => {
          const file = path.join(dir, entry.name);
          try { return { file, time: (await stat(file)).mtimeMs }; }
          catch { return null; }
        }));
        for (const item of files.filter(Boolean).sort((a, b) => b.time - a.time).slice(0, 30)) {
          try { candidates.push(JSON.parse(await readFile(item.file, "utf8"))); } catch {}
        }
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    const history = [];
    const seen = new Set([current.id]);
    for (const task of candidates.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (seen.has(task.id) || !task.workspaceRoot || rootKey(task.workspaceRoot) !== root) continue;
      seen.add(task.id);
      history.push(task);
    }
    return history;
  }
  async function lessons(current, query = "", { touchedPaths = null } = {}) {
    const keyword = String(query).trim().toLowerCase();
    const results = [];
    const seenLesson = new Set();
    const projectKey = normalizeProjectKey(current?.workspaceRoot);
    if (config.stateDir && current?.workspaceRoot) {
      // v0.5 修复：持久化模式严格遵守 candidate-first，绝不经 projectHistory 泄漏未采纳历史 finding
      try {
        const accepted = await queryAcceptedLessons(config.stateDir, {
          workspaceRoot: current.workspaceRoot,
          query,
          touchedPaths,
          limit: 5,
        });
        for (const item of accepted) {
          const text = String(item.lesson ?? "").trim();
          if (!text || seenLesson.has(text.toLowerCase())) continue;
          seenLesson.add(text.toLowerCase());
          results.push({
            source: "accepted-lesson",
            fingerprint: item.fingerprint,
            kind: item.kind ?? item.source,
            taskId: item.sourceTaskIds?.at(-1) ?? null,
            stageId: item.stageId ?? null,
            lesson: text,
            rule: item.rule ?? text,
            ...(item.fileMatch?.length ? { fileMatch: item.fileMatch } : {}),
            occurrences: item.occurrences ?? 1,
            helpful: item.helpful ?? 0,
            harmful: item.harmful ?? 0,
          });
          if (results.length === 5) break;
        }
        if (results.length > 0) {
          try {
            await recordLessonFeedback(config.stateDir, {
              fingerprints: results.map((r) => r.fingerprint),
              outcome: "injected",
              workspaceRoot: current.workspaceRoot,
            });
          } catch {}
        }
      } catch {
        /* 读取异常不阻断主流程 */
      }
      return results;
    }
    // 仅纯内存模式（无 stateDir，兼容隔离单测）才回退检索内存会话历史闭环 finding
    for (const task of await projectHistory(current)) {
      for (const finding of task.findings ?? []) {
        if (finding.status !== "closed") continue;
        const review = task.reviews?.find(item => item.id === finding.resolvedByReviewId && item.verdict === "pass" && !item.selfReviewed);
        if (!review || (keyword && ![task.objective, finding.text].some(value => String(value).toLowerCase().includes(keyword)))) continue;
        const text = String(finding.text ?? "").trim();
        if (seenLesson.has(text.toLowerCase())) continue;
        seenLesson.add(text.toLowerCase());
        results.push({ taskId: task.id, planVersion: review.scope?.planVersion ?? task.planVersion, reviewId: review.id,
          findingId: finding.id, lesson: finding.text, response: finding.responses?.at(-1)?.summary ?? null,
          check: review.checks?.find(item => item.findingIds?.includes(finding.id))?.observation ?? null });
        if (results.length === 5) return results;
      }
    }
    return results;
  }
  async function projectLessons(workspaceRoot) {
    if (!config.stateDir || !workspaceRoot) return { accepted: [], candidates: [], dismissedCount: 0 };
    return listProjectLessons(config.stateDir, { workspaceRoot });
  }
  return {
    get shuttingDown() { return closing; },
    async close() {
      closing = true;
      for (const store of all()) store.shuttingDown = true;
      await Promise.allSettled([...creating.values()]);
    },
    lessons,
    projectLessons,
    async calibration(current, workClass, stageCount) {
      return workClass ? calibrateWork(await projectHistory(current),workClass,stageCount) : null;
    },
    settings: Object.freeze({ ...config, requireCheckpointReviews: true }),
    get: () => selected.get(), set: (next, meta) => selected.set(next, meta), clear: () => selected.clear(),
    all, summaries: summarize, forSession, findSession,
    async forAgent(agent) { return forSession(agent?.session?.id); },
    async select(payload = {}) {
      if (payload.taskId || payload.params?.taskId) {
        const s = taskStore(payload.taskId ?? payload.params.taskId);
        if (!s) throw new Error("任务不存在或尚未加载，请刷新任务列表");
        return s;
      }
      if (payload.sessionId) return forSession(payload.sessionId);
      return selected;
    },
    async archiveBeforeReplace(store) {
      const t=store.get();
      if (config.stateDir && t) await writeState(path.join(config.stateDir,"history",createHash("sha256").update(t.id).digest("hex")+".json"),t);
    },
    flush: () => Promise.all(all().map(s => s.flush?.())),
    async drain() {
      let stable = false;
      while (!stable) {
        await Promise.allSettled([...creating.values()]);
        const current = all();
        const seen = current.map(s => s.flush?.());
        await Promise.all(current.map(s => s.drain?.() ?? s.flush?.()));
        const latest = all();
        stable = creating.size === 0 && latest.length === current.length &&
          latest.every((s, i) => s === current[i] && s.flush?.() === seen[i]);
      }
    },
  };
}
