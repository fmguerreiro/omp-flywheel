import { startDraftProgress } from "./draft-progress";
import { dashboardLines, widgetLines } from "./present";
import { loadCandidates, loadOpenSignals, loadSnapshot, type SnapshotRun } from "./snapshot-client";
import { parseTriagePromotion, parseTriageProposal, type FlywheelCandidate, type FlywheelOpenSignal } from "./protocol";
import {
  initialViewState,
  loadingViewState,
  readyViewState,
  unavailableViewState,
  type FlywheelViewState,
} from "./state";

type DashboardThemeColor =
  | "accent"
  | "border"
  | "error"
  | "mdCode"
  | "mdCodeBlock"
  | "mdHeading"
  | "mdListBullet"
  | "mdQuote"
  | "muted"
  | "success"
  | "toolDiffAdded"
  | "toolDiffContext"
  | "toolDiffRemoved"
  | "warning";

interface DashboardTheme {
  fg?(color: DashboardThemeColor, text: string): string;
  bold?(text: string): string;
  boxRound?: {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
    teeRight: string;
    teeLeft: string;
  };
}

interface DashboardComponent {
  render(width: number): readonly string[];
  invalidate(): void;
  handleInput(data: string): void;
}

interface DashboardUi {
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setWidget(
    key: string,
    content: string[] | undefined,
    options: { placement: "aboveEditor" | "belowEditor" },
  ): void;
  custom<T>(
    factory: (
      tui: { requestRender(): void },
      theme: DashboardTheme,
      keybindings: unknown,
      done: (result: T) => void,
    ) => DashboardComponent,
    options?: { overlay?: boolean },
  ): Promise<T>;
}

type DashboardKey = "escape" | "tab" | "j" | "k" | "r" | "d" | "x" | "p";

// Kitty terminals encode ordinary key presses and repeats as CSI-u sequences.
const DASHBOARD_KEY_SEQUENCES: Record<DashboardKey, readonly string[]> = {
  escape: ["\u001b", "\u001b[27u", "\u001b[27;1u", "\u001b[27;1:1u", "\u001b[27;1:2u"],
  tab: ["\t", "\u001b[9u", "\u001b[9;1u", "\u001b[9;1:1u", "\u001b[9;1:2u"],
  j: ["j", "\u001b[106u", "\u001b[106;1u", "\u001b[106;1:1u", "\u001b[106;1:2u"],
  k: ["k", "\u001b[107u", "\u001b[107;1u", "\u001b[107;1:1u", "\u001b[107;1:2u"],
  r: ["r", "\u001b[114u", "\u001b[114;1u", "\u001b[114;1:1u", "\u001b[114;1:2u"],
  d: ["d", "\u001b[100u", "\u001b[100;1u", "\u001b[100;1:1u", "\u001b[100;1:2u"],
  x: ["x", "\u001b[120u", "\u001b[120;1u", "\u001b[120;1:1u", "\u001b[120;1:2u"],
  p: ["p", "\u001b[112u", "\u001b[112;1u", "\u001b[112;1:1u", "\u001b[112;1:2u"],
};

function matchesDashboardKey(data: string, key: DashboardKey): boolean {
  return DASHBOARD_KEY_SEQUENCES[key].includes(data);
}


interface DashboardContext {
  cwd: string;
  mode: string;
  ui: DashboardUi;
  model?: { provider: string; id: string };
  sessionManager?: { getSessionFile(): string | undefined };
}

interface DashboardExtensionApi {
  exec(
    command: string,
    args: string[],
    options: { cwd: string; timeout: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  on(event: "session_start", handler: (event: unknown, ctx: DashboardContext) => void): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: DashboardContext) => Promise<void>;
    },
  ): void;
  registerShortcut(
    shortcut: "ctrl+shift+f",
    options: {
      description: string;
      handler: (ctx: DashboardContext) => Promise<void>;
    },
  ): void;
}

function isMainSession(ctx: DashboardContext): boolean {
  const transcript = ctx.sessionManager?.getSessionFile();
  if (!transcript) return true;

  const parts = transcript.split(/[\\/]/);
  const sessions = parts.lastIndexOf("sessions");
  return sessions < 0 || parts.length - sessions === 3;
}

function color(theme: DashboardTheme, token: DashboardThemeColor, text: string): string {
  return theme.fg?.(token, text) ?? text;
}

function bold(theme: DashboardTheme, text: string): string {
  return theme.bold?.(text) ?? text;
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(width - 1, 0))}…`;
}

function wrappedText(text: string, width: number): string[] {
  const limit = Math.max(width, 1);
  const normalized = text.trim();
  if (!normalized) return [""];

  const lines: string[] = [];
  let remaining = normalized;
  while (remaining) {
    if (remaining.length <= limit) {
      lines.push(remaining);
      break;
    }
    const boundary = remaining.lastIndexOf(" ", limit);
    const end = boundary > 0 ? boundary : limit;
    lines.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(boundary > 0 ? end + 1 : end).trimStart();
  }
  return lines;
}

function boxChars(theme: DashboardTheme) {
  return theme.boxRound ?? {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    teeRight: "├",
    teeLeft: "┤",
  };
}

type BoxBodyLine =
  | { text: string; color?: DashboardThemeColor; strong?: boolean }
  | { divider: string };

function boxLine(theme: DashboardTheme, text: string, token: DashboardThemeColor, width: number, strong = false): string {
  const chars = boxChars(theme);
  const inner = width - 4;
  const content = clip(text, inner);
  const styled = strong ? bold(theme, color(theme, token, content)) : color(theme, token, content);
  return `${color(theme, "border", chars.vertical)} ${styled}${" ".repeat(Math.max(0, inner - content.length))} ${color(theme, "border", chars.vertical)}`;
}

function boxDivider(theme: DashboardTheme, label: string, width: number): string {
  const chars = boxChars(theme);
  const prefix = `${chars.teeRight}${chars.horizontal} `;
  const text = clip(label, width - prefix.length - 1);
  const suffixLength = Math.max(0, width - prefix.length - text.length - 1);
  return `${color(theme, "border", prefix)}${color(theme, "muted", text)} ${color(theme, "border", chars.horizontal.repeat(suffixLength) + chars.teeLeft)}`;
}

function boxed(
  theme: DashboardTheme,
  width: number,
  title: string,
  titleColor: DashboardThemeColor,
  body: readonly BoxBodyLine[],
): string[] {
  const cardWidth = Math.max(12, Math.min(width, 100));
  const chars = boxChars(theme);
  const border = color(theme, "border", `${chars.topLeft}${chars.horizontal.repeat(cardWidth - 2)}${chars.topRight}`);
  const lines = [border, boxLine(theme, title, titleColor, cardWidth, true)];
  for (const line of body) {
    if ("divider" in line) {
      lines.push(boxDivider(theme, line.divider, cardWidth));
    } else {
      lines.push(boxLine(theme, line.text, line.color ?? "muted", cardWidth, line.strong));
    }
  }
  lines.push(color(theme, "border", `${chars.bottomLeft}${chars.horizontal.repeat(cardWidth - 2)}${chars.bottomRight}`));
  return lines;
}

function markdownLineColor(text: string, inCode: boolean, isDiff: boolean): DashboardThemeColor {
  if (inCode && isDiff) {
    if (text.startsWith("+") && !text.startsWith("+++")) return "toolDiffAdded";
    if (text.startsWith("-") && !text.startsWith("---")) return "toolDiffRemoved";
    return "toolDiffContext";
  }
  if (inCode) return "mdCodeBlock";
  if (text.startsWith("#")) return "mdHeading";
  if (text.startsWith(">")) return "mdQuote";
  if (/^(?:[-*+] |\d+\. )/.test(text)) return "mdListBullet";
  if (text.startsWith("|") || text.startsWith("```")) return "mdCode";
  return "muted";
}

function modifiedFiles(text: string): string[] {
  const files = new Set<string>();
  for (const line of text.replaceAll("\r", "").split("\n")) {
    const patchFile = /^(?:\+\+\+ b\/|\*\*\* (?:Update|Add|Delete) File:\s*)(.+)$/.exec(line)?.[1];
    const diffFile = /^diff --git a\/(.+) b\/(.+)$/.exec(line)?.[2];
    const file = patchFile ?? diffFile;
    if (file && file !== "/dev/null") files.add(file);
  }
  return [...files].slice(0, 3);
}

function markdownExcerpt(text: string, width: number): Array<{ text: string; color: DashboardThemeColor; strong?: boolean }> {
  const source = text.slice(0, 2_400).replaceAll("\r", "");
  if (!source.trim()) return [{ text: "No prior agent response captured.", color: "muted" }];

  const lines: Array<{ text: string; color: DashboardThemeColor; strong?: boolean }> = [];
  let inCode = false;
  let diffCode = false;
  const hasDiff = /^(?:diff --git|@@ |--- [ab]\/|\+\+\+ [ab]\/)/m.test(source);

  for (const sourceLine of source.split("\n")) {
    const line = sourceLine.trimEnd();
    if (line.startsWith("```")) {
      if (!inCode) {
        diffCode = hasDiff || /\bdiff\b/i.test(line);
        const language = line.slice(3).trim();
        lines.push({ text: language ? `Code · ${language}` : "Code", color: "mdCode", strong: true });
      }
      inCode = !inCode;
      continue;
    }

    const colorToken = markdownLineColor(line, inCode, diffCode);
    const display = inCode ? line : line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replaceAll("**", "");
    for (const wrapped of wrappedText(display, width)) {
      lines.push({ text: wrapped, color: colorToken, strong: !inCode && (line.startsWith("#") || line.includes("**")) });
      if (lines.length === 14) return [...lines, { text: "…", color: "muted" }];
    }
  }
  return source.length < text.length ? [...lines.slice(0, 13), { text: "…", color: "muted" }] : lines;
}


export default function flywheelDashboard(pi: DashboardExtensionApi): void {
  let state: FlywheelViewState = initialViewState();
  let signals: readonly FlywheelOpenSignal[] | undefined;
  let selectedSignal = 0;
  let candidates: readonly FlywheelCandidate[] | undefined;
  let selectedCandidate = 0;
  let view: "corrections" | "candidates" = "corrections";
  let busy = false;
  let dashboardOpen = false;

  function setWidget(ctx: DashboardContext, content: string[] | undefined): void {
    ctx.ui.setWidget("agent-flywheel", content, { placement: dashboardOpen ? "aboveEditor" : "belowEditor" });
  }

  function updateWidget(ctx: DashboardContext): void {
    setWidget(ctx, widgetLines(state));
  }

  async function refresh(ctx: DashboardContext, redraw?: () => void): Promise<void> {
    const selectedId = candidates?.[selectedCandidate]?.id;
    state = loadingViewState(state);
    signals = undefined;
    candidates = undefined;
    updateWidget(ctx);
    redraw?.();

    const run: SnapshotRun = ({ argv, cwd, timeout }) => pi.exec(argv[0] ?? "", argv.slice(1), { cwd, timeout });
    const result = await loadSnapshot(run, ctx.cwd);
    if (result.kind === "ready") {
      const [loadedSignals, loadedCandidates] = await Promise.all([
        result.snapshot.counts.signals_open > 0 ? loadOpenSignals(run, ctx.cwd) : undefined,
        result.snapshot.counts.cases_candidate > 0 ? loadCandidates(run, ctx.cwd) : undefined,
      ]);
      signals = loadedSignals === undefined ? [] : loadedSignals.kind === "ready" ? loadedSignals.signals.signals : undefined;
      candidates = loadedCandidates === undefined ? [] : loadedCandidates.kind === "ready" ? loadedCandidates.candidates.candidates : undefined;
      selectedSignal = Math.min(selectedSignal, Math.max((signals?.length ?? 1) - 1, 0));
      const preserved = candidates?.findIndex((candidate) => candidate.id === selectedId) ?? -1;
      selectedCandidate = preserved >= 0 ? preserved : Math.min(selectedCandidate, Math.max((candidates?.length ?? 1) - 1, 0));
      if (result.snapshot.counts.signals_open === 0 && result.snapshot.counts.cases_candidate > 0) view = "candidates";
      else if (result.snapshot.counts.cases_candidate === 0) view = "corrections";
    }
    state = result.kind === "ready" ? readyViewState(result.snapshot) : unavailableViewState();
    updateWidget(ctx);
    redraw?.();
  }

  function reviewLines(theme: DashboardTheme, width: number): string[] {
    if (state.kind !== "ready" || state.snapshot.counts.signals_open === 0) return [];

    if (signals === undefined) {
      return boxed(theme, width, "Correction details", "warning", [{ text: "Open correction details unavailable.", color: "muted" }]);
    }
    if (signals.length === 0) {
      return boxed(theme, width, "Correction details", "warning", [{ text: "No open corrections returned.", color: "muted" }]);
    }

    const signal = signals[selectedSignal];
    if (!signal) return [];

    const inner = Math.max(8, Math.min(width, 100) - 4);
    const correction = signal.reason?.replaceAll(/[\r\n\t]+/g, " ").trim() || "No correction text captured.";
    const files = modifiedFiles(signal.assistant_text ?? "");
    const body: BoxBodyLine[] = [
      { text: `${signal.kind} · ${signal.component ?? "unclassified"}`, color: "warning", strong: true },
      { divider: "Reported correction" },
      ...wrappedText(correction, inner).map((text) => ({ text, color: "warning" as const })),
      ...(files.length > 0 ? [{ divider: "Modified files" }, ...files.map((text) => ({ text, color: "mdCode" as const }))] : []),
      { divider: "Prior agent response" },
      ...markdownExcerpt(signal.assistant_text ?? "", inner),
    ];
    return boxed(theme, width, `Correction ${selectedSignal + 1}/${signals.length} · #${signal.id}`, "accent", body);
  }

  function candidateLines(theme: DashboardTheme, width: number): string[] {
    if (state.kind !== "ready") return [];
    const candidate = candidates?.[selectedCandidate];
    if (!candidate) {
      return boxed(theme, width, "Proposed improvements", "warning", [{
        text: candidates === undefined ? "Candidate details unavailable. Press r to retry." : "No candidate details returned. Press r to refresh.",
        color: "warning",
      }]);
    }

    const inner = Math.max(8, Math.min(width, 100) - 4);
    const diagnosis = (candidate.diagnosis ?? "No description captured.").replaceAll(/[\r\n\t]+/g, " ");
    const description = wrappedText(diagnosis, inner);
    const draft = candidate.latest_draft;
    const retry = draft && draft.status !== "running";
    const next = draft?.status === "running"
      ? "Draft in progress. Press r to check its status."
      : `Press d to ${retry ? "retry drafting" : "draft"} this improvement. Flywheel chooses the instruction file and tests the change.`;
    const body: BoxBodyLine[] = [
      { text: `Saved suggestion · severity: ${candidate.severity ?? "not rated"}${candidate.component ? ` · ${candidate.component}` : ""}`, color: "muted" },
      { divider: "Proposed behavior change" },
      ...description.slice(0, 12).map((text) => ({ text, color: "accent" as const })),
      ...(description.length > 12 ? [{ text: "… Full description appears before drafting.", color: "muted" as const }] : []),
      ...(draft ? [
        { divider: "Previous attempt" },
        { text: `Draft ${draft.status.replaceAll("_", " ")}`, color: draft.status === "running" ? "accent" as const : "warning" as const },
        ...wrappedText(draft.error?.replaceAll(/[\r\n\t]+/g, " ") ?? "", inner).filter(Boolean).slice(0, 3).map((text) => ({ text, color: "warning" as const })),
      ] : [{ text: "No instruction file changed yet.", color: "muted" as const }]),
      { divider: "Next step" },
      ...wrappedText(next, inner).map((text) => ({ text, color: "accent" as const })),
      ...wrappedText("Passing checks automatically pushes to origin/main. No second approval.", inner).map((text) => ({ text, color: "warning" as const })),
    ];
    const total = state.snapshot.counts.cases_candidate;
    return boxed(theme, width, `Candidate ${selectedCandidate + 1}/${candidates?.length}${total > (candidates?.length ?? 0) ? ` shown · ${total} saved` : ""}`, "accent", body);
  }

  function controlLines(width: number): BoxBodyLine[] {
    const wrap = (text: string): BoxBodyLine[] => wrappedText(text, Math.max(8, Math.min(width, 100) - 4)).map((text) => ({ text, color: "muted" }));
    if (state.kind !== "ready") return wrap(state.kind === "loading" ? "Loading details… · Esc Close" : "r Refresh · Esc Close");
    const switchView = state.snapshot.counts.signals_open > 0 && state.snapshot.counts.cases_candidate > 0
      ? `Tab ${view === "candidates" ? "Corrections" : "Candidates"} · `
      : "";
    if (view === "candidates") {
      const candidate = candidates?.[selectedCandidate];
      return wrap(`${switchView}${candidate ? `j/k Select candidate · ${candidate.latest_draft?.status === "running" ? "" : "d Draft selected · "}` : ""}r Refresh · Esc Close`);
    }
    return [
      ...wrap(`${switchView}${signals?.length ? "j/k Select correction · p Analyze · x Reject · " : ""}r Refresh · Esc Close`),
      ...wrap(signals?.length ? "Analyze a correction, then authorize drafting, evaluation, and automatic publication if checks pass." : "No open corrections. Nothing to analyze."),
    ];
  }

  async function rejectSignal(ctx: DashboardContext, signal: FlywheelOpenSignal): Promise<void> {
    if (!await ctx.ui.confirm("Reject correction", `Reject correction #${signal.id}?`)) return;
    busy = true;
    const result = await pi.exec(process.env.AGENT_FLYWHEEL_CLI ?? "agent-flywheel", ["triage-reject", String(signal.id)], {
      cwd: ctx.cwd,
      timeout: 5_000,
    });
    busy = false;
    ctx.ui.notify(result.code === 0 ? `Rejected correction #${signal.id}.` : `Could not reject correction #${signal.id}.`, result.code === 0 ? "info" : "error");
    await refresh(ctx);
  }

  function draftRunning(): boolean {
    return busy || candidates?.some((candidate) => candidate.latest_draft?.status === "running") === true
      || (state.kind === "ready" && state.snapshot.latest_draft?.status === "running");
  }

  async function promoteSignal(ctx: DashboardContext, signal: FlywheelOpenSignal): Promise<void> {
    if (draftRunning()) {
      ctx.ui.notify("A Flywheel draft is already running.", "warning");
      return;
    }
    busy = true;
    setWidget(ctx, [`Flywheel · Analyzing correction #${signal.id}…`]);
    try {
      const args = ["triage-propose", String(signal.id), "--json"];
      if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
      const analysis = await pi.exec(
        process.env.AGENT_FLYWHEEL_CLI ?? "agent-flywheel",
        args,
        { cwd: ctx.cwd, timeout: 900_000 },
      );
      if (analysis.code !== 0) {
        throw new Error(analysis.stderr.trim() || "Flywheel could not analyze this correction.");
      }
      const proposal = parseTriageProposal(analysis.stdout, signal.id);
      if (!await ctx.ui.confirm(
        "Review suggested improvement",
        `Your correction: ${signal.reason ?? signal.kind}\n\nSuggested behavior change:\n${proposal.diagnosis}\n\nSeverity: ${proposal.severity}\n\nFlywheel will choose the instruction file, write a change in an isolated checkout, and run evaluation checks.\n\nIf checks pass, it automatically commits and pushes to origin/main. There is no second approval.\n\nStart drafting?`,
      )) return;
      const result = await pi.exec(
        process.env.AGENT_FLYWHEEL_CLI ?? "agent-flywheel",
        ["triage-promote", String(signal.id), "--json", "--fingerprint", proposal.fingerprint, "--severity", proposal.severity, "--diagnosis", proposal.diagnosis],
        { cwd: ctx.cwd, timeout: 5_000 },
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `Could not save candidate for correction #${signal.id}.`);
      }
      const caseId = parseTriagePromotion(result.stdout, signal.id);
      await executeDraft(ctx, caseId);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Could not analyze this correction.", "error");
      await refresh(ctx);
    } finally {
      busy = false;
      updateWidget(ctx);
    }
  }

  async function draftCandidate(ctx: DashboardContext, candidate: FlywheelCandidate): Promise<void> {
    if (draftRunning()) {
      ctx.ui.notify("A Flywheel draft is already running.", "warning");
      return;
    }
    busy = true;
    try {
      if (!await ctx.ui.confirm(
        "Draft selected improvement?",
        `${candidate.diagnosis ?? "No description captured."}\n\nFlywheel will choose the instruction file, write a change in an isolated checkout, and run evaluation checks.\n\nIf checks pass, it automatically commits and pushes to origin/main. There is no second approval.\n\nStart drafting?`,
      )) return;
      await executeDraft(ctx, candidate.id);
    } finally {
      busy = false;
      updateWidget(ctx);
    }
  }

  async function executeDraft(ctx: DashboardContext, caseId: string): Promise<void> {
    let progress: Awaited<ReturnType<typeof startDraftProgress>> | undefined;
    try {
      progress = await startDraftProgress((lines) => setWidget(ctx, lines));
      const result = await pi.exec(
        process.env.AGENT_FLYWHEEL_CLI ?? "agent-flywheel",
        ["draft", "--case", caseId, "--repo", ctx.cwd, "--progress-file", progress.path],
        { cwd: ctx.cwd, timeout: 900_000 },
      );
      ctx.ui.notify(result.code === 0 ? result.stdout.trim() || "Draft attempt finished." : result.stderr.trim() || result.stdout.trim() || "Draft failed.", result.code === 0 ? "info" : "error");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Could not draft improvement.", "error");
    } finally {
      try {
        await progress?.close();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not remove draft progress files.", "warning");
      } finally {
        await refresh(ctx);
        const drafted = candidates?.findIndex((candidate) => candidate.id === caseId) ?? -1;
        if (drafted >= 0) {
          selectedCandidate = drafted;
          view = "candidates";
          updateWidget(ctx);
        }
      }
    }
  }

  async function openDashboard(ctx: DashboardContext): Promise<void> {
    if (!isMainSession(ctx)) {
      ctx.ui.notify("Agent Flywheel dashboard is available in the main agent only.", "warning");
      return;
    }

    if (ctx.mode !== "tui") {
      ctx.ui.notify("Agent Flywheel dashboard requires the interactive TUI.", "warning");
      return;
    }
    if (busy) return;

    dashboardOpen = true;
    updateWidget(ctx);
    try {
      while (true) {
        const action = await ctx.ui.custom<"reject" | "promote" | "draft" | undefined>((tui, theme, _keybindings, done) => ({
          render: (width) => [
            ...boxed(
              theme,
              width,
              `Flywheel · ${view === "candidates" ? "Candidates" : "Corrections"}`,
              "accent",
              dashboardLines(state).map((text) => ({ text, color: state.kind === "ready" ? "muted" as const : "warning" as const })),
            ),
            ...(view === "candidates" ? candidateLines(theme, width) : reviewLines(theme, width)),
            ...boxed(
              theme,
              width,
              busy ? "Working…" : "Controls",
              busy ? "warning" : "muted",
              controlLines(width),
            ),
          ],
          invalidate: () => {},
          capturesInput: () => true,
          handleInput: (data) => {
            if (matchesDashboardKey(data, "escape")) {
              done(undefined);
              return;
            }
            if (busy || state.kind === "loading") return;
            if (matchesDashboardKey(data, "r")) {
              void refresh(ctx, () => tui.requestRender());
              return;
            }
            if (state.kind !== "ready") return;
            if (matchesDashboardKey(data, "tab")) {
              if (state.snapshot.counts.signals_open > 0 && state.snapshot.counts.cases_candidate > 0) {
                view = view === "corrections" ? "candidates" : "corrections";
                tui.requestRender();
              }
              return;
            }
            if (matchesDashboardKey(data, "j") || matchesDashboardKey(data, "k")) {
              const step = matchesDashboardKey(data, "j") ? 1 : -1;
              if (view === "candidates") selectedCandidate = Math.max(0, Math.min(selectedCandidate + step, (candidates?.length ?? 1) - 1));
              else selectedSignal = Math.max(0, Math.min(selectedSignal + step, (signals?.length ?? 1) - 1));
              tui.requestRender();
              return;
            }
            if (view === "candidates") {
              const candidate = candidates?.[selectedCandidate];
              if (matchesDashboardKey(data, "d") && candidate && candidate.latest_draft?.status !== "running") done("draft");
              return;
            }
            const signal = signals?.[selectedSignal];
            if (!signal) return;
            if (matchesDashboardKey(data, "x")) done("reject");
            if (matchesDashboardKey(data, "p")) done("promote");
          },
        }));
        if (action === undefined) return;
        const signal = signals?.[selectedSignal];
        const candidate = candidates?.[selectedCandidate];
        if ((action === "draft" && candidate) || (action === "promote" && signal)) {
          dashboardOpen = false;
          updateWidget(ctx);
          try {
            if (action === "draft" && candidate) await draftCandidate(ctx, candidate);
            else if (signal) await promoteSignal(ctx, signal);
          } finally {
            dashboardOpen = true;
            updateWidget(ctx);
          }
        } else if (signal && action === "reject") await rejectSignal(ctx, signal);
      }
    } finally {
      dashboardOpen = false;
      updateWidget(ctx);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (!isMainSession(ctx)) return;
    state = initialViewState();
    signals = undefined;
    selectedSignal = 0;
    candidates = undefined;
    selectedCandidate = 0;
    view = "corrections";
    void refresh(ctx);
  });

  pi.registerCommand("flywheel", {
    description: "Review Agent Flywheel corrections and run candidate drafts",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/flywheel does not accept arguments.", "warning");
        return;
      }

      await openDashboard(ctx);
    },
  });

  pi.registerShortcut("ctrl+shift+f", {
    description: "Open the Agent Flywheel dashboard",
    handler: openDashboard,
  });
}
