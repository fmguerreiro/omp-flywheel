import type { FlywheelSnapshotV1 } from "./protocol";
import type { FlywheelViewState } from "./state";


function counted(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
function actionItems(snapshot: FlywheelSnapshotV1): string[] {
  const items: string[] = [];
  const { counts, latest_draft: latestDraft, latest_eval: latestEval } = snapshot;

  if (counts.signals_open > 0) {
    items.push(`${counts.signals_open} correction${counts.signals_open === 1 ? "" : "s"} need triage`);
  }
  if (counts.cases_candidate > 0) {
    items.push(`${counts.cases_candidate} candidate${counts.cases_candidate === 1 ? "" : "s"} to review and draft`);
  }

  switch (latestDraft?.status) {
    case "failed":
      items.push("Latest draft failed");
      break;
    case "blocked":
      items.push("Latest draft blocked");
      break;
    case "needs_revision":
      items.push("Latest draft needs revision");
      break;
  }

  switch (latestEval?.result) {
    case "regressed":
      items.push("Latest evaluation regressed");
      break;
    case "same-fail":
      items.push("Latest evaluation still failing");
      break;
  }

  return items;
}

function summaryLine(snapshot: FlywheelSnapshotV1): string {
  const { counts } = snapshot;
  const items = [
    counted(counts.sessions, "session"),
    counted(counts.signals_open, "correction"),
  ];
  if (counts.cases_candidate > 0) items.push(counted(counts.cases_candidate, "candidate"));
  if (counts.cases_active > 0) items.push(`${counts.cases_active} active`);
  if (counts.eval_runs > 0) items.push(counted(counts.eval_runs, "eval"));
  return items.join(" · ");
}

export function widgetLines(state: FlywheelViewState): string[] | undefined {
  if (state.kind !== "ready") return undefined;

  const items = actionItems(state.snapshot);
  return items.length > 0 ? [`Flywheel · ${items.join(" · ")} · /flywheel`] : undefined;
}

export function dashboardLines(state: FlywheelViewState): string[] {
  switch (state.kind) {
    case "collecting":
      return ["No snapshot loaded. Press r to refresh."];
    case "loading":
      return state.snapshot ? [summaryLine(state.snapshot)] : ["Loading snapshot…"];
    case "ready":
      return [summaryLine(state.snapshot)];
    case "unavailable":
      return ["Snapshot unavailable. Press r to retry."];
  }
}
