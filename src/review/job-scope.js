export function sameReviewScope(a, b) {
  return a.kind === b.kind && a.stageId === b.stageId && a.attempt === b.attempt && a.planVersion === b.planVersion;
}

// Retries are appended. Only the newest job for the current scope may act.
export function latestReviewJob(task, job) {
  return (task.reviewJobs ?? []).findLast(candidate => sameReviewScope(candidate, job));
}

export function isRetryableReview(task, job) {
  if (job.status !== "failed" || job.planVersion !== task.planVersion || latestReviewJob(task, job)?.id !== job.id) return false;
  if (job.kind === "stage") {
    return (task.nodeRuns ?? []).some(run => run.stageId === job.stageId && run.attempt === job.attempt && run.status === "reported");
  }
  return task.pendingCheckpoint?.kind === job.kind;
}
