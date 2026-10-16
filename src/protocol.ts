export const MAX_SNAPSHOT_BYTES = 64 * 1024;

export type CaseStatus = "candidate" | "active";
export type DraftStatus = "running" | "failed" | "blocked" | "needs_revision" | "fixed";
export type EvalResult = "fixed" | "regressed" | "same-pass" | "same-fail";

export interface FlywheelCounts {
  sessions: number;
  signals_open: number;
  cases_candidate: number;
  cases_active: number;
  eval_runs: number;
}

export interface FlywheelLatestEval {
  case_id: string | null;
  result: EvalResult | null;
  created_at: string;
}

export interface FlywheelLatestDraft {
  case_id: string;
  status: DraftStatus;
  created_at: string;
  completed_at: string | null;
  retry_count: number;
}

export interface FlywheelRecentCase {
  id: string;
  component: string | null;
  severity: string | null;
  status: CaseStatus;
  created_at: string;
}

export interface FlywheelSnapshotV1 {
  schema_version: 1;
  generated_at: string;
  counts: FlywheelCounts;
  latest_eval: FlywheelLatestEval | null;
  latest_draft: FlywheelLatestDraft | null;
  recent_cases: FlywheelRecentCase[];
}

export interface FlywheelOpenSignal {
  id: number;
  kind: string;
  component: string | null;
  reason: string | null;
  assistant_text: string | null;
  created_at: string;
}

export interface FlywheelOpenSignalsV1 {
  schema_version: 1;
  signals: FlywheelOpenSignal[];
}

export interface FlywheelCandidate {
  id: string;
  component: string | null;
  severity: string | null;
  diagnosis: string | null;
  created_at: string;
  latest_draft: { status: DraftStatus; error: string | null } | null;
}

export interface FlywheelCandidatesV1 {
  schema_version: 1;
  candidates: FlywheelCandidate[];
}

type JsonRecord = Record<string, unknown>;

const CASE_STATUSES: Record<string, true> = { candidate: true, active: true };
const DRAFT_STATUSES: Record<string, true> = {
  running: true,
  failed: true,
  blocked: true,
  needs_revision: true,
  fixed: true,
};
const EVAL_RESULTS: Record<string, true> = {
  fixed: true,
  regressed: true,
  "same-pass": true,
  "same-fail": true,
};
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function invalid(message: string): never {
  throw new TypeError(`Invalid Flywheel snapshot: ${message}`);
}

function parseOneLine(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > MAX_SNAPSHOT_BYTES) {
    invalid("output exceeds size limit");
  }

  const line = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) {
    invalid("output must be one JSON line");
  }

  try {
    return JSON.parse(line);
  } catch {
    invalid("not valid JSON");
  }
}

function record(value: unknown, name: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, name: string, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    invalid(`${name} has unknown or missing fields`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      invalid(`${name} has unknown or missing fields`);
    }
  }
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") {
    invalid(`${name} must be a string`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : string(value, name);
}

function count(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function timestamp(value: unknown, name: string): string {
  const text = string(value, name);
  const match = ISO_TIMESTAMP.exec(text);
  if (match === null) {
    invalid(`${name} must be an ISO timestamp`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    invalid(`${name} must be an ISO timestamp`);
  }
  return text;
}

function oneOf<T extends string>(value: unknown, name: string, allowed: Record<string, true>): T {
  const text = string(value, name);
  if (!Object.hasOwn(allowed, text)) {
    invalid(`${name} has unsupported status`);
  }
  return text as T;
}

function parseCounts(value: unknown): FlywheelCounts {
  const source = record(value, "counts");
  exactKeys(source, "counts", ["sessions", "signals_open", "cases_candidate", "cases_active", "eval_runs"]);
  return {
    sessions: count(source.sessions, "counts.sessions"),
    signals_open: count(source.signals_open, "counts.signals_open"),
    cases_candidate: count(source.cases_candidate, "counts.cases_candidate"),
    cases_active: count(source.cases_active, "counts.cases_active"),
    eval_runs: count(source.eval_runs, "counts.eval_runs"),
  };
}

function parseLatestEval(value: unknown): FlywheelLatestEval | null {
  if (value === null) {
    return null;
  }
  const source = record(value, "latest_eval");
  exactKeys(source, "latest_eval", ["case_id", "result", "created_at"]);
  const result = nullableString(source.result, "latest_eval.result");
  return {
    case_id: nullableString(source.case_id, "latest_eval.case_id"),
    result: result === null ? null : oneOf<EvalResult>(result, "latest_eval.result", EVAL_RESULTS),
    created_at: timestamp(source.created_at, "latest_eval.created_at"),
  };
}

function parseLatestDraft(value: unknown): FlywheelLatestDraft | null {
  if (value === null) {
    return null;
  }
  const source = record(value, "latest_draft");
  exactKeys(source, "latest_draft", ["case_id", "status", "created_at", "completed_at", "retry_count"]);
  const completedAt = nullableString(source.completed_at, "latest_draft.completed_at");
  return {
    case_id: string(source.case_id, "latest_draft.case_id"),
    status: oneOf<DraftStatus>(source.status, "latest_draft.status", DRAFT_STATUSES),
    created_at: timestamp(source.created_at, "latest_draft.created_at"),
    completed_at: completedAt === null ? null : timestamp(completedAt, "latest_draft.completed_at"),
    retry_count: count(source.retry_count, "latest_draft.retry_count"),
  };
}

function parseRecentCases(value: unknown): FlywheelRecentCase[] {
  if (!Array.isArray(value)) {
    invalid("recent_cases must be an array");
  }
  return value.map((item, index) => {
    const source = record(item, `recent_cases[${index}]`);
    exactKeys(source, `recent_cases[${index}]`, ["id", "component", "severity", "status", "created_at"]);
    return {
      id: string(source.id, `recent_cases[${index}].id`),
      component: nullableString(source.component, `recent_cases[${index}].component`),
      severity: nullableString(source.severity, `recent_cases[${index}].severity`),
      status: oneOf<CaseStatus>(source.status, `recent_cases[${index}].status`, CASE_STATUSES),
      created_at: timestamp(source.created_at, `recent_cases[${index}].created_at`),
    };
  });
}

export function parseOpenSignals(text: string): FlywheelOpenSignalsV1 {
  const source = record(parseOneLine(text), "open signals");
  exactKeys(source, "open signals", ["schema_version", "signals"]);
  if (source.schema_version !== 1) {
    invalid("unsupported open-signal schema version");
  }
  if (!Array.isArray(source.signals)) {
    invalid("signals must be an array");
  }

  return {
    schema_version: 1,
    signals: source.signals.map((item, index) => {
      const signal = record(item, `signals[${index}]`);
      exactKeys(signal, `signals[${index}]`, ["id", "kind", "component", "reason", "assistant_text", "created_at"]);
      return {
        id: count(signal.id, `signals[${index}].id`),
        kind: string(signal.kind, `signals[${index}].kind`),
        component: nullableString(signal.component, `signals[${index}].component`),
        reason: nullableString(signal.reason, `signals[${index}].reason`),
        assistant_text: nullableString(signal.assistant_text, `signals[${index}].assistant_text`),
        created_at: timestamp(signal.created_at, `signals[${index}].created_at`),
      };
    }),
  };
}

export function parseTriageProposal(text: string, signalId: number) {
  const source = record(parseOneLine(text), "triage proposal");
  exactKeys(source, "triage proposal", ["schema_version", "signal_id", "fingerprint", "severity", "diagnosis"]);
  if (source.schema_version !== 1 || source.signal_id !== signalId) {
    invalid("proposal does not match the selected correction");
  }
  const fingerprint = string(source.fingerprint, "fingerprint").trim();
  const diagnosis = string(source.diagnosis, "diagnosis").trim();
  if (!fingerprint || !diagnosis) {
    invalid("proposal must include a fingerprint and diagnosis");
  }
  return {
    fingerprint,
    severity: oneOf<"low" | "medium" | "high">(source.severity, "severity", { low: true, medium: true, high: true }),
    diagnosis,
  };
}

export function parseTriagePromotion(text: string, signalId: number): string {
  const source = record(parseOneLine(text), "triage promotion");
  exactKeys(source, "triage promotion", ["schema_version", "signal_id", "case_id"]);
  if (source.schema_version !== 1 || source.signal_id !== signalId) {
    invalid("promotion does not match the selected correction");
  }
  const caseId = string(source.case_id, "case_id");
  if (!caseId.trim() || caseId !== caseId.trim()) invalid("promotion must include a case ID");
  return caseId;
}

export function parseCandidates(text: string): FlywheelCandidatesV1 {
  const source = record(parseOneLine(text), "candidates");
  exactKeys(source, "candidates", ["schema_version", "candidates"]);
  if (source.schema_version !== 1) invalid("unsupported schema version");
  if (!Array.isArray(source.candidates)) invalid("candidates must be an array");
  return {
    schema_version: 1,
    candidates: source.candidates.map((item, index) => {
      const name = `candidates[${index}]`;
      const candidate = record(item, name);
      exactKeys(candidate, name, ["id", "component", "severity", "diagnosis", "created_at", "latest_draft"]);
      let latestDraft: FlywheelCandidate["latest_draft"] = null;
      if (candidate.latest_draft !== null) {
        const draft = record(candidate.latest_draft, `${name}.latest_draft`);
        exactKeys(draft, `${name}.latest_draft`, ["status", "error"]);
        latestDraft = {
          status: oneOf<DraftStatus>(draft.status, `${name}.latest_draft.status`, DRAFT_STATUSES),
          error: nullableString(draft.error, `${name}.latest_draft.error`),
        };
      }
      return {
        id: string(candidate.id, `${name}.id`),
        component: nullableString(candidate.component, `${name}.component`),
        severity: nullableString(candidate.severity, `${name}.severity`),
        diagnosis: nullableString(candidate.diagnosis, `${name}.diagnosis`),
        created_at: timestamp(candidate.created_at, `${name}.created_at`),
        latest_draft: latestDraft,
      };
    }),
  };
}

export function parseSnapshot(text: string): FlywheelSnapshotV1 {
  const source = record(parseOneLine(text), "snapshot");
  exactKeys(source, "snapshot", ["schema_version", "generated_at", "counts", "latest_eval", "latest_draft", "recent_cases"]);
  if (source.schema_version !== 1) {
    invalid("unsupported schema version");
  }

  return {
    schema_version: 1,
    generated_at: timestamp(source.generated_at, "generated_at"),
    counts: parseCounts(source.counts),
    latest_eval: parseLatestEval(source.latest_eval),
    latest_draft: parseLatestDraft(source.latest_draft),
    recent_cases: parseRecentCases(source.recent_cases),
  };
}
