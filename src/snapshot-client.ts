import { MAX_SNAPSHOT_BYTES, parseCandidates, parseOpenSignals, parseSnapshot, type FlywheelCandidatesV1, type FlywheelOpenSignalsV1, type FlywheelSnapshotV1 } from "./protocol";

export interface SnapshotRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SnapshotRunOptions {
  argv: string[];
  cwd: string;
  timeout: number;
}

export type SnapshotRun = (options: SnapshotRunOptions) => Promise<SnapshotRunResult>;

export type SnapshotLoad =
  | { kind: "ready"; snapshot: FlywheelSnapshotV1 }
  | { kind: "unavailable" };

export type OpenSignalsLoad =
  | { kind: "ready"; signals: FlywheelOpenSignalsV1 }
  | { kind: "unavailable" };

export type CandidatesLoad =
  | { kind: "ready"; candidates: FlywheelCandidatesV1 }
  | { kind: "unavailable" };

const SNAPSHOT_TIMEOUT_MS = 1_500;

export async function loadSnapshot(run: SnapshotRun, cwd: string): Promise<SnapshotLoad> {
  try {
    const result = await run({
      argv: [process.env.AGENT_FLYWHEEL_CLI ?? "agent-flywheel", "snapshot", "--json"],
      cwd,
      timeout: SNAPSHOT_TIMEOUT_MS,
    });
    if (result.code !== 0 || new TextEncoder().encode(result.stdout).byteLength > MAX_SNAPSHOT_BYTES) {
      return { kind: "unavailable" };
    }
    return { kind: "ready", snapshot: parseSnapshot(result.stdout) };
  } catch {
    return { kind: "unavailable" };
  }
}

export async function loadOpenSignals(run: SnapshotRun, cwd: string): Promise<OpenSignalsLoad> {
  try {
    const result = await run({
      argv: [process.env.AGENT_FLYWHEEL_CLI ?? "agent-flywheel", "signals", "--json"],
      cwd,
      timeout: SNAPSHOT_TIMEOUT_MS,
    });
    if (result.code !== 0 || new TextEncoder().encode(result.stdout).byteLength > MAX_SNAPSHOT_BYTES) {
      return { kind: "unavailable" };
    }
    return { kind: "ready", signals: parseOpenSignals(result.stdout) };
  } catch {
    return { kind: "unavailable" };
  }
}

export async function loadCandidates(run: SnapshotRun, cwd: string): Promise<CandidatesLoad> {
  try {
    const result = await run({
      argv: [process.env.AGENT_FLYWHEEL_CLI ?? "agent-flywheel", "candidates", "--json"],
      cwd,
      timeout: SNAPSHOT_TIMEOUT_MS,
    });
    if (result.code !== 0 || new TextEncoder().encode(result.stdout).byteLength > MAX_SNAPSHOT_BYTES) {
      return { kind: "unavailable" };
    }
    return { kind: "ready", candidates: parseCandidates(result.stdout) };
  } catch {
    return { kind: "unavailable" };
  }
}
