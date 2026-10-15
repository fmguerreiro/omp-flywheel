import type { FlywheelSnapshotV1 } from "./protocol";

export type FlywheelViewState =
  | { kind: "collecting" }
  | { kind: "loading"; snapshot: FlywheelSnapshotV1 | null }
  | { kind: "ready"; snapshot: FlywheelSnapshotV1 }
  | { kind: "unavailable" };

export function initialViewState(): FlywheelViewState {
  return { kind: "collecting" };
}

export function loadingViewState(previous?: FlywheelViewState): FlywheelViewState {
  if (previous?.kind === "ready" || previous?.kind === "loading") {
    return { kind: "loading", snapshot: previous.snapshot };
  }

  return { kind: "loading", snapshot: null };
}

export function readyViewState(snapshot: FlywheelSnapshotV1): FlywheelViewState {
  return { kind: "ready", snapshot };
}

export function unavailableViewState(): FlywheelViewState {
  return { kind: "unavailable" };
}
