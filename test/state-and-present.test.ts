import { describe, expect, test } from "bun:test";

import { dashboardLines, widgetLines } from "../src/present";
import {
  initialViewState,
  loadingViewState,
  readyViewState,
  unavailableViewState,
} from "../src/state";
import type { FlywheelSnapshotV1 } from "../src/protocol";

const snapshot: FlywheelSnapshotV1 = {
  schema_version: 1,
  generated_at: "2026-10-14T12:00:00Z",
  counts: {
    sessions: 12,
    signals_open: 3,
    cases_candidate: 4,
    cases_active: 2,
    eval_runs: 8,
  },
  latest_eval: {
    case_id: "case-eval-hidden",
    result: "fixed",
    created_at: "2026-10-14T11:00:00Z",
  },
  latest_draft: {
    case_id: "case-draft-hidden",
    status: "fixed",
    created_at: "2026-10-14T10:00:00Z",
    completed_at: "2026-10-14T10:05:00Z",
    retry_count: 1,
  },
  recent_cases: [
    {
      id: "case-recent-hidden",
      component: "hidden-component",
      severity: "high",
      status: "active",
      created_at: "2026-10-14T09:00:00Z",
    },
  ],
};

describe("Flywheel view state", () => {
  test("starts and resets as non-durable collection", () => {
    expect(initialViewState()).toEqual({ kind: "collecting" });
    expect(loadingViewState(initialViewState())).toEqual({
      kind: "loading",
      snapshot: null,
    });
  });

  test("moves from loading to ready and retains safe prior snapshot while refreshing", () => {
    const loading = loadingViewState();
    expect(loading).toEqual({ kind: "loading", snapshot: null });

    const ready = readyViewState(snapshot);
    expect(ready).toEqual({ kind: "ready", snapshot });
    expect(loadingViewState(ready)).toEqual({ kind: "loading", snapshot });
  });

  test("moves from any state to unavailable without subprocess error data", () => {
    expect(unavailableViewState()).toEqual({ kind: "unavailable" });
  });
});

describe("Flywheel presenters", () => {
  test("hides the widget when no durable work is pending or state is unavailable", () => {
    expect(widgetLines(readyViewState({
      ...snapshot,
      counts: { ...snapshot.counts, signals_open: 0, cases_candidate: 0 },
      latest_eval: null,
      latest_draft: null,
    }))).toBeUndefined();
    expect(widgetLines(initialViewState())).toBeUndefined();
    expect(widgetLines(loadingViewState())).toBeUndefined();
    expect(widgetLines(unavailableViewState())).toBeUndefined();
  });

  test.each(["fixed", "same-pass", null] as const)(
    "published drafts with successful or absent evaluation history need no review (%s)",
    (result) => {
      expect(widgetLines(readyViewState({
        ...snapshot,
        counts: { ...snapshot.counts, signals_open: 0, cases_candidate: 0 },
        latest_eval: result === null ? null : { ...snapshot.latest_eval!, result },
      }))).toBeUndefined();
    },
  );

  test("never renders private snapshot fields", () => {
    const output = [...(widgetLines(readyViewState(snapshot)) ?? []), ...dashboardLines(readyViewState(snapshot))].join("\n");

    expect(output).not.toContain("case-eval-hidden");
    expect(output).not.toContain("case-draft-hidden");
    expect(output).not.toContain("case-recent-hidden");
    expect(output).not.toContain("hidden-component");
    expect(output).not.toContain("2026-10-14T");
  });
});
