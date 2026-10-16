import { describe, expect, test } from "bun:test";

import {
  MAX_DETAILS_BYTES,
  parseCandidates,
  MAX_SNAPSHOT_BYTES,
  parseOpenSignals,
  parseSnapshot,
  parseTriagePromotion,
  parseTriageProposal,
  type FlywheelOpenSignalsV1,
  type FlywheelSnapshotV1,
} from "../src/protocol";
import { loadCandidates, loadOpenSignals, loadSnapshot } from "../src/snapshot-client";

const validSnapshot: FlywheelSnapshotV1 = {
  schema_version: 1 as const,
  generated_at: "2026-10-14T12:34:56.789Z",
  counts: {
    sessions: 4,
    signals_open: 3,
    cases_candidate: 2,
    cases_active: 1,
    eval_runs: 5,
  },
  latest_eval: {
    case_id: "case-1",
    result: "fixed",
    created_at: "2026-10-14T12:00:00Z",
  },
  latest_draft: {
    case_id: "case-1",
    status: "fixed",
    created_at: "2026-10-14T11:00:00Z",
    completed_at: "2026-10-14T11:30:00Z",
    retry_count: 0,
  },
  recent_cases: [
    {
      id: "case-1",
      component: "dashboard",
      severity: "high",
      status: "active",
      created_at: "2026-10-14T10:00:00Z",
    },
  ],
};

const validJson = JSON.stringify(validSnapshot);

const validOpenSignals: FlywheelOpenSignalsV1 = {
  schema_version: 1,
  signals: [{
    id: 7,
    kind: "corrected",
    component: "dashboard",
    reason: "Show a way to review open corrections.",
    assistant_text: "The dashboard only shows correction text.",
    created_at: "2026-10-14T12:00:00Z",
  }],
};

const validOpenSignalsJson = JSON.stringify(validOpenSignals);

describe("parseSnapshot", () => {
  test("accepts exact safe v1 projection", () => {
    expect(parseSnapshot(`${validJson}\n`)).toEqual(validSnapshot);
  });

  test("rejects missing or unknown fields", () => {
    expect(() => parseSnapshot(JSON.stringify({ ...validSnapshot, generated_at: undefined }))).toThrow();
    expect(() => parseSnapshot(JSON.stringify({ ...validSnapshot, worktree_path: "/tmp/worktree" }))).toThrow();
  });

  test("rejects sensitive raw fields at every projection level", () => {
    expect(() => parseSnapshot(JSON.stringify({ ...validSnapshot, transcript_path: "/secret" }))).toThrow();
    expect(() =>
      parseSnapshot(
        JSON.stringify({
          ...validSnapshot,
          recent_cases: [{ ...validSnapshot.recent_cases[0], diagnosis: "raw diagnosis" }],
        }),
      ),
    ).toThrow();
  });

  test("rejects invalid schema, statuses, timestamps, and counts", () => {
    expect(() => parseSnapshot(JSON.stringify({ ...validSnapshot, schema_version: 2 }))).toThrow();
    expect(() =>
      parseSnapshot(
        JSON.stringify({ ...validSnapshot, recent_cases: [{ ...validSnapshot.recent_cases[0], status: "deleted" }] }),
      ),
    ).toThrow();
    expect(() => parseSnapshot(JSON.stringify({ ...validSnapshot, generated_at: "2026-02-30T12:00:00Z" }))).toThrow();
    expect(() =>
      parseSnapshot(
        JSON.stringify({ ...validSnapshot, counts: { ...validSnapshot.counts, sessions: -1 } }),
      ),
    ).toThrow();
    expect(() => parseSnapshot(validJson.replace('"sessions":4', '"sessions":1e999'))).toThrow();
  });

  test("rejects multiple lines and oversized output", () => {
    expect(() => parseSnapshot(`${validJson}\n${validJson}`)).toThrow();
    expect(() => parseSnapshot(`${validJson}${" ".repeat(MAX_SNAPSHOT_BYTES)}`)).toThrow();
  });
});

describe("parseOpenSignals", () => {
  test("accepts the local review projection and rejects fields outside it", () => {
    expect(parseOpenSignals(`${validOpenSignalsJson}\n`)).toEqual(validOpenSignals);
    expect(() =>
      parseOpenSignals(JSON.stringify({
        ...validOpenSignals,
        signals: [{ ...validOpenSignals.signals[0], payload_json: '{"raw":"transcript"}' }],
      })),
    ).toThrow();
    expect(() =>
      parseOpenSignals(JSON.stringify({
        ...validOpenSignals,
        signals: [{ ...validOpenSignals.signals[0], id: -1 }],
      })),
    ).toThrow();
  });
});

describe("parseTriageProposal", () => {
  const proposal = {
    schema_version: 1,
    signal_id: 7,
    fingerprint: "missing-correction-context",
    severity: "medium",
    diagnosis: "Include correction context so users can understand what needs review.",
  };

  test("rejects a proposal for a different correction", () => {
    expect(() => parseTriageProposal(JSON.stringify(proposal), 8)).toThrow();
  });

  test("refuses incomplete or unsupported model analysis", () => {
    expect(() => parseTriageProposal(JSON.stringify({ ...proposal, diagnosis: " " }), 7)).toThrow();
    expect(() => parseTriageProposal(JSON.stringify({ ...proposal, fingerprint: null }), 7)).toThrow();
    expect(() => parseTriageProposal(JSON.stringify({ ...proposal, severity: "critical" }), 7)).toThrow();
  });
});

describe("parseTriagePromotion", () => {
  const promotion = { schema_version: 1, signal_id: 7, case_id: "case-new-correction" };

  test("returns the exact created case ID from the selected correction's promotion", () => {
    expect(parseTriagePromotion(`${JSON.stringify(promotion)}\n`, 7)).toBe("case-new-correction");
  });

  test("rejects missing IDs, different corrections, and unsupported responses", () => {
    for (const value of [
      { ...promotion, schema_version: 2 },
      { ...promotion, signal_id: 8 },
      { schema_version: 1, signal_id: 7 },
      { ...promotion, case_id: null },
      { ...promotion, case_id: "" },
      { ...promotion, case_id: " " },
      { ...promotion, case_id: " case-new-correction " },
      { ...promotion, diagnosis: "not part of the promotion contract" },
    ]) {
      expect(() => parseTriagePromotion(JSON.stringify(value), 7)).toThrow();
    }
    expect(() => parseTriagePromotion("promoted signal 7 to case case-new-correction\n", 7)).toThrow();
    expect(() => parseTriagePromotion(`${JSON.stringify(promotion)}\n${JSON.stringify(promotion)}`, 7)).toThrow();
  });
});

describe("loadSnapshot", () => {

  test("returns unavailable for nonzero process, malformed output, timeout, and oversized output", async () => {
    expect(
      await loadSnapshot(async () => ({ code: 1, stdout: validJson, stderr: "failure" }), "/repo"),
    ).toEqual({ kind: "unavailable" });
    expect(
      await loadSnapshot(async () => ({ code: 0, stdout: "not json", stderr: "" }), "/repo"),
    ).toEqual({ kind: "unavailable" });
    expect(
      await loadSnapshot(async () => Promise.reject(new Error("timeout")), "/repo"),
    ).toEqual({ kind: "unavailable" });
    expect(
      await loadSnapshot(async () => ({ code: 0, stdout: "x".repeat(MAX_SNAPSHOT_BYTES + 1), stderr: "" }), "/repo"),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("Unicode detail pages", () => {
  function asciiJson(value: unknown): string {
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }

  test("loads a full candidate page with escaped Unicode diagnoses and errors", async () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      id: `case-${index}`,
      component: "verification",
      severity: "medium",
      diagnosis: "🧪".repeat(2_000),
      created_at: "2026-10-14T12:00:00Z",
      latest_draft: { status: "failed" as const, error: "🧪".repeat(500) },
    }));
    const loaded = await loadCandidates(async () => ({
      code: 0, stdout: asciiJson({ schema_version: 1, candidates }), stderr: "",
    }), "/repo");
    expect(loaded).toEqual({ kind: "ready", candidates: { schema_version: 1, candidates } });
  });

  test("loads a full correction page with escaped Unicode evidence", async () => {
    const signals = Array.from({ length: 20 }, (_, index) => ({
      ...validOpenSignals.signals[0]!,
      id: index + 1,
      reason: "🧪".repeat(300),
      assistant_text: "🧪".repeat(1_500),
    }));
    const loaded = await loadOpenSignals(async () => ({
      code: 0, stdout: asciiJson({ schema_version: 1, signals }), stderr: "",
    }), "/repo");
    expect(loaded).toEqual({ kind: "ready", signals: { schema_version: 1, signals } });
  });

  test("rejects detail pages beyond the encoded-byte limit", async () => {
    const padding = " ".repeat(MAX_DETAILS_BYTES);
    const candidates = `${JSON.stringify({ schema_version: 1, candidates: [] })}${padding}`;
    const signals = `${validOpenSignalsJson}${padding}`;
    expect(() => parseCandidates(candidates)).toThrow("output exceeds size limit");
    expect(() => parseOpenSignals(signals)).toThrow("output exceeds size limit");
    expect(await loadCandidates(async () => ({ code: 0, stdout: candidates, stderr: "" }), "/repo"))
      .toEqual({ kind: "unavailable" });
    expect(await loadOpenSignals(async () => ({ code: 0, stdout: signals, stderr: "" }), "/repo"))
      .toEqual({ kind: "unavailable" });
  });
});
