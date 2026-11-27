// Harness renders guard denials as "Error: <reason>" in the durable result.
export const WORKER_DENIAL = Object.freeze({
  STOPPED: "worker-attempt-stopped",
  TOOL: "worker-tool-not-allowed",
  PATH: "worker-write-path-unavailable",
  OUTSIDE: "worker-write-outside-owned-paths",
  LINK: "worker-write-through-link",
});

const known = new Set(Object.values(WORKER_DENIAL));
export function workerDenial(text) {
  if (typeof text !== "string") return null;
  const firstLine = text.trim().split(/\r?\n/u, 1)[0].trim();
  const reason = firstLine.replace(/^(?:Error:\s*)+/iu, "");
  const code = reason.split(/[:\s]/u, 1)[0];
  if (!known.has(code)) return null;
  if (code !== reason && !reason.startsWith(code + ":")) return null;
  return {code, reason};
}
