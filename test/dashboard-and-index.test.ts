import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import flywheelExtension from "../src/index";

const snapshot = JSON.stringify({
  schema_version: 1,
  generated_at: "2026-10-14T12:00:00Z",
  counts: {
    sessions: 3,
    signals_open: 2,
    cases_candidate: 1,
    cases_active: 4,
    eval_runs: 5,
  },
  latest_eval: null,
  latest_draft: null,
  recent_cases: [],
});

const openSignals = JSON.stringify({
  schema_version: 1,
  signals: [{
    id: 7,
    kind: "corrected",
    component: "dashboard",
    reason: "Show corrections in the dashboard.",
    assistant_text: "## Dashboard regression\n```diff\ndiff --git a/src/dashboard.ts b/src/dashboard.ts\n-old output\n+boxed output\n```",
    created_at: "2026-10-14T12:00:00Z",
  }],
});

const triageProposal = {
  schema_version: 1,
  signal_id: 7,
  fingerprint: "missing-correction-context",
  severity: "medium",
  diagnosis: "Show the proposed behavior change before asking users to draft.",
};

const candidateCases = [
  {
    id: "case-review-context",
    component: "dashboard",
    severity: "medium",
    diagnosis: "Show the proposed behavior change before asking users to draft.",
    created_at: "2026-10-14T12:00:00Z",
    latest_draft: null,
  },
  {
    id: "case-publish-warning",
    component: "dashboard",
    severity: "high",
    diagnosis: "Explain automatic publication before starting candidate evaluation.",
    created_at: "2026-10-14T12:01:00Z",
    latest_draft: null,
  },
];

type CandidateFixture = Omit<(typeof candidateCases)[number], "latest_draft"> & {
  latest_draft: { status: "running" | "failed" | "blocked"; error: string | null } | null;
};

function candidatesJson(candidates: readonly CandidateFixture[] = candidateCases): string {
  return JSON.stringify({ schema_version: 1, candidates });
}

type ExtensionApi = Parameters<typeof flywheelExtension>[0];
type SessionStartHandler = Parameters<ExtensionApi["on"]>[1];
type DashboardContext = Parameters<SessionStartHandler>[1];
type CommandHandler = Parameters<ExtensionApi["registerCommand"]>[1]["handler"];
type ShortcutHandler = Parameters<ExtensionApi["registerShortcut"]>[1]["handler"];
type CustomUi = DashboardContext["ui"]["custom"];
type CustomFactory = Parameters<CustomUi>[0];
type CustomFactoryParameters = Parameters<CustomFactory>;
type CustomOptions = Parameters<CustomUi>[1];
type DashboardComponent = {
  render(width: number): readonly string[];
  invalidate(): void;
  handleInput(data: string): void;
};
type OverlayFactory<T> = (
  tui: CustomFactoryParameters[0],
  theme: CustomFactoryParameters[1],
  keybindings: CustomFactoryParameters[2],
  done: (result: T) => void,
) => DashboardComponent;
type ExecResult = { code: number; stdout: string; stderr: string };

function candidateDashboard(options: {
  candidates?: readonly CandidateFixture[];
  corrections?: boolean;
  signalsJson?: string;
  authorizeDraft?: boolean;
  analyze?: (args: string[], options: { cwd: string; timeout: number }) => Promise<ExecResult>;
  promote?: (args: string[], options: { cwd: string; timeout: number }) => Promise<ExecResult>;
  draft?: (args: string[], options: { cwd: string; timeout: number }) => Promise<ExecResult>;
} = {}) {
  let candidates = options.candidates ?? candidateCases;
  let corrections = options.corrections ?? false;
  let sessionStart: SessionStartHandler | undefined;
  let command: CommandHandler | undefined;
  let component: DashboardComponent | undefined;
  let commandDone: Promise<void> | undefined;
  let overlayActive = false;
  let overlayCount = 0;
  let snapshotRequests = 0;
  let returnedCandidates = 0;
  let completedRefreshes = 0;
  const requests: string[][] = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const widgets: Array<{ content: string[] | undefined; placement: "aboveEditor" | "belowEditor" }> = [];
  const notices: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
  const widgetWaiters: Array<{ matches(content: string[]): boolean; resolve(content: string[]): void }> = [];
  const overlayWaiters = new Map<number, { resolve(): void }>();
  const refreshWaiters = new Map<number, { resolve(): void }>();

  const extension: ExtensionApi = {
    exec: async (_commandName, args, execOptions) => {
      requests.push([...args]);
      if (args.includes("snapshot")) {
        snapshotRequests += 1;
        const previous = JSON.parse(snapshot);
        return {
          code: 0,
          stdout: JSON.stringify({
            ...previous,
            counts: {
              ...previous.counts,
              signals_open: corrections ? 1 : 0,
              cases_candidate: candidates.length,
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("candidates")) {
        returnedCandidates = snapshotRequests;
        return { code: 0, stdout: candidatesJson(candidates), stderr: "" };
      }
      if (args.includes("signals")) return { code: 0, stdout: options.signalsJson ?? openSignals, stderr: "" };
      if (args.includes("triage-propose")) {
        return options.analyze?.(args, execOptions) ?? { code: 0, stdout: JSON.stringify(triageProposal), stderr: "" };
      }
      if (args.includes("triage-promote") && options.promote) return options.promote(args, execOptions);
      if (args.includes("draft") && options.draft) return options.draft(args, execOptions);
      if (args.includes("draft") || args.includes("triage-reject")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    },
    on: (_event, handler) => {
      sessionStart = handler;
    },
    registerCommand: (_name, registration) => {
      command = registration.handler;
    },
    registerShortcut: () => {},
  };

  const context: DashboardContext = {
    cwd: "/tmp/repository",
    mode: "tui",
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    ui: {
      confirm: async (title, message) => {
        expect(overlayActive).toBe(false);
        confirmations.push({ title, message });
        return options.authorizeDraft ?? false;
      },
      notify: (message, type) => notices.push({ message, type }),
      setWidget: (_key, content, placement) => {
        widgets.push({ content, placement: placement.placement });
        for (let index = widgetWaiters.length - 1; index >= 0; index -= 1) {
          const waiter = widgetWaiters[index]!;
          if (content && waiter.matches(content)) {
            widgetWaiters.splice(index, 1);
            waiter.resolve(content);
          }
        }
        if (returnedCandidates !== snapshotRequests || completedRefreshes === snapshotRequests) return;
        completedRefreshes = snapshotRequests;
        refreshWaiters.get(completedRefreshes)?.resolve();
      },
      custom: <T>(factory: OverlayFactory<T>, _options?: CustomOptions) => {
        overlayActive = true;
        overlayCount += 1;
        return new Promise<T>((resolve) => {
          component = factory(
            { requestRender: () => {} },
            { fg: (_color, text) => text, bold: (text) => text },
            {},
            (result) => {
              overlayActive = false;
              resolve(result);
            },
          );
          overlayWaiters.get(overlayCount)?.resolve();
        });
      },
    },
    sessionManager: { getSessionFile: () => "/tmp/sessions/repository/main.jsonl" },
  };

  flywheelExtension(extension);

  function waitForRefresh(): Promise<void> {
    if (completedRefreshes === snapshotRequests) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    refreshWaiters.set(snapshotRequests, waiter);
    return waiter.promise;
  }

  function waitForOverlay(count: number): Promise<void> {
    if (overlayCount >= count) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    overlayWaiters.set(count, waiter);
    return waiter.promise;
  }

  return {
    requests,
    confirmations,
    widgets,
    notices,
    waitForWidget(matches: (content: string[]) => boolean): Promise<string[]> {
      const current = widgets.at(-1)?.content;
      if (current && matches(current)) return Promise.resolve(current);
      const waiter = Promise.withResolvers<string[]>();
      widgetWaiters.push({ matches, resolve: waiter.resolve });
      return waiter.promise;
    },
    waitForRefresh,
    waitForOverlay,
    setCandidates(next: readonly CandidateFixture[]) {
      candidates = next;
    },
    setCorrections(next: boolean) {
      corrections = next;
    },
    async start() {
      if (!sessionStart || !command) throw new Error("extension registrations missing");
      sessionStart({}, context);
      await waitForRefresh();
      commandDone = command("", context);
      await waitForOverlay(1);
    },
    press(key: string) {
      if (!component || !overlayActive) throw new Error("dashboard overlay is not active");
      component.handleInput(key);
    },
    render(): readonly string[] {
      if (!component || !overlayActive) throw new Error("dashboard overlay is not active");
      return component.render(80);
    },
    async openAgain() {
      if (!command) throw new Error("command missing");
      await command("", context);
    },
    async close() {
      this.press("\u001b");
      await commandDone;
    },
  };
}

describe("flywheel dashboard extension", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("removes terminal controls from correction evidence and proposal confirmation", async () => {
    const controls = "\u001b[2J\u001b]52;c;cG9pc29u\u0007\u0008";
    const dashboard = candidateDashboard({
      corrections: true,
      signalsJson: JSON.stringify({
        schema_version: 1,
        signals: [{
          id: 7,
          kind: `corrected${controls}`,
          component: `verification${controls}`,
          reason: `Exercise${controls} the changed path.`,
          assistant_text: `## Verified${controls} behavior\n\`\`\`diff\n+++ b/src/client.ts${controls}\n-old\n+new\n\`\`\``,
          created_at: "2026-10-14T12:00:00Z",
        }],
      }),
      analyze: async () => ({
        code: 0,
        stdout: JSON.stringify({ ...triageProposal, diagnosis: `Verify${controls} the changed path.` }),
        stderr: "",
      }),
    });
    await dashboard.start();
    const rendered = dashboard.render().join("\n");
    expect(rendered).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(rendered).toContain("Verified behavior");
    expect(rendered).toContain("Exercise the changed path.");
    expect(rendered).toContain("src/client.ts");
    expect(rendered).toContain("+new");
    dashboard.press("p");
    await dashboard.waitForOverlay(2);
    expect(dashboard.confirmations[0]?.message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(dashboard.confirmations[0]?.message).toContain("Verify the changed path.");
    expect(dashboard.confirmations[0]?.message).toContain("automatically commits and pushes to origin/main");
    await dashboard.close();
  });

  test("removes terminal controls from candidate cards, confirmations, and failures", async () => {
    const controls = "\u001b[2J\u001b]52;c;cG9pc29u\u0007\u0008";
    const dashboard = candidateDashboard({
      candidates: [{
        ...candidateCases[0]!,
        component: `verification${controls}`,
        diagnosis: `Exercise${controls} the changed path.`,
        latest_draft: { status: "failed", error: `Verifier${controls} failed.` },
      }],
      authorizeDraft: true,
      draft: async () => ({ code: 1, stdout: "", stderr: `Evaluation${controls} failed.` }),
    });
    await dashboard.start();
    const rendered = dashboard.render().join("\n");
    expect(rendered).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(rendered).toContain("Exercise the changed path.");
    expect(rendered).toContain("Verifier failed.");
    dashboard.press("d");
    await dashboard.waitForOverlay(2);
    expect(dashboard.confirmations[0]?.message).toContain("Exercise the changed path.");
    expect(dashboard.confirmations[0]?.message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(dashboard.notices.at(-1)).toEqual({ message: "Evaluation failed.", type: "error" });
    await dashboard.close();
  });

  test("refreshes an overlay and completes after close", async () => {
    let sessionStart: SessionStartHandler | undefined;
    let command: CommandHandler | undefined;
    let shortcut: ShortcutHandler | undefined;
    let overlay: DashboardComponent | undefined;
    const widgets: Array<{ key: string; content: string[] | undefined; placement: "aboveEditor" | "belowEditor" }> = [];
    const notices: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
    let confirmations = 0;
    const requests: string[][] = [];
    let overlayActive = false;
    let overlayCount = 0;
    const reopened = Promise.withResolvers<void>();
    const initialSnapshot = Promise.withResolvers<ExecResult>();
    const refreshedSnapshot = Promise.withResolvers<ExecResult>();
    const snapshotResults = [initialSnapshot, refreshedSnapshot];
    const refreshed = Promise.withResolvers<void>();
    const redrawn = Promise.withResolvers<void>();
    let renders = 0;

    const extension: ExtensionApi = {
      exec: (_commandName, args, _options) => {
        requests.push([...args]);
        if (args.includes("triage-propose")) {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({
              schema_version: 1,
              signal_id: 7,
              fingerprint: "missing-correction-context",
              severity: "medium",
              diagnosis: "Include correction context so users can understand what needs review.",
            }),
            stderr: "",
          });
        }
        if (args.includes("signals")) {
          return Promise.resolve({ code: 0, stdout: openSignals, stderr: "" });
        }
        if (args.includes("candidates")) {
          return Promise.resolve({ code: 0, stdout: candidatesJson(candidateCases.slice(0, 1)), stderr: "" });
        }
        return snapshotResults.shift()?.promise ?? Promise.reject(new Error("unexpected snapshot request"));
      },
      on: (_event, handler) => {
        sessionStart = handler;
      },
      registerCommand: (_name, options) => {
        command = options.handler;
      },
      registerShortcut: (_shortcut, options) => {
        shortcut = options.handler;
      },
    };

    flywheelExtension(extension);

    const context = (
      mode: DashboardContext["mode"] = "tui",
      transcript = "/tmp/sessions/repository/main.jsonl",
    ): DashboardContext => ({
      cwd: "/tmp/repository",
      mode,
      ui: {
        confirm: async () => {
          expect(overlayActive).toBe(false);
          confirmations += 1;
          return false;
        },
        notify: (message, type) => notices.push({ message, type }),
        setWidget: (key, content, options) => {
          widgets.push({ key, content, placement: options.placement });
          if (content !== undefined) refreshed.resolve();
        },
        custom: <T>(factory: OverlayFactory<T>, _options?: CustomOptions) => {
          overlayActive = true;
          overlayCount += 1;
          return new Promise<T>((resolve) => {
            overlay = factory(
              {
                requestRender: () => {
                  renders += 1;
                  if (renders === 2) redrawn.resolve();
                },
              },
              {
                fg: (color, text) => `<${color}>${text}</${color}>`,
                bold: (text) => `<bold>${text}</bold>`,
              },
              {},
              (result) => {
                overlayActive = false;
                resolve(result);
              },
            );
            if (overlayCount === 2) reopened.resolve();
          });
        },
      },
      sessionManager: { getSessionFile: () => transcript },
    });

    if (!sessionStart || !command || !shortcut) throw new Error("extension registrations missing");

    sessionStart({}, context("tui", "/tmp/sessions/repository/main/Worker.jsonl"));
    const subagentWidgetCount = widgets.length;
    sessionStart({}, context());
    expect(widgets.at(-1)).toEqual({
      key: "agent-flywheel",
      content: undefined,
      placement: "belowEditor",
    });
    initialSnapshot.resolve({ code: 0, stdout: snapshot, stderr: "" });
    await refreshed.promise;

    await command("unexpected", context());
    const commandPromise = command("", context());
    const component = overlay;
    if (!component) throw new Error("dashboard overlay missing");
    component.render(80);
    component.handleInput("r");
    refreshedSnapshot.resolve({ code: 0, stdout: snapshot, stderr: "" });
    await redrawn.promise;
    component.render(80);
    component.handleInput("\u001b[112;1u");
    await reopened.promise;
    if (!overlay) throw new Error("dashboard did not reopen after cancelled promotion");
    overlay.handleInput("\u001b[27;1u");
    await commandPromise;

    await shortcut(context("print"));

    expect(subagentWidgetCount).toBe(0);
    expect(notices.filter((notice) => notice.type === "warning")).toHaveLength(2);
    expect(confirmations).toBe(1);
    expect(requests.filter((args) => args.includes("snapshot"))).toHaveLength(2);
    expect(requests.filter((args) => args.includes("triage-propose"))).toHaveLength(1);
    expect(requests.some((args) => args.includes("triage-promote"))).toBe(false);
    expect(requests.some((args) => args.includes("draft"))).toBe(false);
    expect(renders).toBeGreaterThanOrEqual(2);
  });

  test.each([true, false])("drafts the selected candidate only with authorization (%s)", async (authorizeDraft) => {
    const dashboard = candidateDashboard({ authorizeDraft });
    await dashboard.start();
    dashboard.press("\t");
    dashboard.press("j");
    dashboard.press("d");
    await dashboard.waitForOverlay(2);
    await dashboard.close();

    expect(dashboard.confirmations).toHaveLength(1);
    const confirmation = dashboard.confirmations[0];
    expect(confirmation?.message).toContain(candidateCases[1]!.diagnosis);
    expect(confirmation?.message).not.toContain(candidateCases[0]!.diagnosis);
    expect(confirmation?.message).toContain("origin/main");
    expect(confirmation?.message).toMatch(/automat\w*[\s\S]*push|push[\s\S]*automat/i);
    expect(confirmation?.message).toMatch(/no (?:second|additional|further) approval|without (?:a second|another|additional|further) approval/i);
    expect(confirmation?.message).toMatch(/if[\s\S]*(?:check|eval|test)[\s\S]*pass|pass(?:ing|ed)?[\s\S]*(?:check|eval|test)|fixed/i);
    const drafts = dashboard.requests.filter((args) => args.includes("draft"));
    expect(drafts).toHaveLength(authorizeDraft ? 1 : 0);
    if (authorizeDraft) {
      expect(drafts[0]).toEqual(["draft", "--case", candidateCases[1]!.id, "--progress-file", expect.any(String)]);
    }
    expect(dashboard.requests.some((args) => args.some((arg) => arg.startsWith("triage-")))).toBe(false);
  });

  test.each(["p", "\u001b[112;1u"])("one correction authorization immediately drafts its exact promoted case (%s)", async (key) => {
    const started = Promise.withResolvers<string>();
    const completed = Promise.withResolvers<ExecResult>();
    const promoted = { ...candidateCases[0]!, id: "case-created-from-correction" };
    const dashboard = candidateDashboard({
      corrections: true,
      authorizeDraft: true,
      promote: async () => {
        expect(dashboard.confirmations).toHaveLength(1);
        expect(dashboard.requests.some((request) => request.includes("draft"))).toBe(false);
        dashboard.setCandidates([candidateCases[1]!, candidateCases[0]!, promoted]);
        dashboard.setCorrections(false);
        return { code: 0, stdout: JSON.stringify({ schema_version: 1, signal_id: 7, case_id: promoted.id }), stderr: "" };
      },
      draft: async (args, execOptions) => {
        expect(execOptions).toEqual({ cwd: "/tmp/repository", timeout: 900_000 });
        started.resolve(args[args.indexOf("--progress-file") + 1]!);
        return completed.promise;
      },
    });
    await dashboard.start();
    dashboard.press(key);
    const path = await started.promise;
    try {
      expect(dashboard.confirmations).toHaveLength(1);
      expect(dashboard.widgets.at(-1)?.placement).toBe("belowEditor");
      expect(dashboard.widgets.at(-1)?.content?.join(" ")).toContain("elapsed");
      expect(dashboard.requests.filter((args) => args.includes("snapshot"))).toHaveLength(1);
      await dashboard.openAgain();
    } finally {
      completed.resolve({ code: 0, stdout: "Published evaluated change.", stderr: "" });
      await dashboard.waitForOverlay(2);
      await dashboard.close();
    }
    expect(dashboard.confirmations).toHaveLength(1);
    expect(dashboard.notices.at(-1)).toEqual({ message: "Published evaluated change.", type: "info" });
    expect(await stat(dirname(path)).then(() => true, () => false)).toBe(false);
  });

  test("declining correction review leaves it open without promotion or draft", async () => {
    const dashboard = candidateDashboard({ corrections: true });
    await dashboard.start();
    dashboard.press("p");
    await dashboard.waitForOverlay(2);
    expect(dashboard.render().join("\n")).toContain("Correction 1/1 · #7");
    await dashboard.close();

    expect(dashboard.confirmations).toHaveLength(1);
    expect(dashboard.requests.filter((args) => args.includes("triage-propose"))).toHaveLength(1);
    expect(dashboard.requests.some((args) => args.includes("triage-promote") || args.includes("draft"))).toBe(false);
  });

  test.each(["analysis", "promotion", "invalid promotion"] as const)("%s failure never drafts another saved case", async (failure) => {
    const dashboard = candidateDashboard({
      corrections: true,
      authorizeDraft: true,
      analyze: async () => failure === "analysis"
        ? { code: 1, stdout: "", stderr: "Model analysis failed." }
        : { code: 0, stdout: JSON.stringify(triageProposal), stderr: "" },
      promote: async () => failure === "promotion"
        ? { code: 2, stdout: "", stderr: "Fingerprint already has a case." }
        : { code: 0, stdout: JSON.stringify({ schema_version: 1, signal_id: 8, case_id: candidateCases[0]!.id }), stderr: "" },
    });
    await dashboard.start();
    dashboard.press("p");
    await dashboard.waitForOverlay(2);
    expect(dashboard.render().join("\n")).toContain("Correction 1/1 · #7");
    await dashboard.close();

    expect(dashboard.confirmations).toHaveLength(failure === "analysis" ? 0 : 1);
    expect(dashboard.requests.filter((args) => args.includes("triage-promote"))).toHaveLength(failure === "analysis" ? 0 : 1);
    expect(dashboard.requests.some((args) => args.includes("draft"))).toBe(false);
    expect(dashboard.notices.at(-1)).toEqual({
      type: "error",
      message: failure === "analysis" ? "Model analysis failed."
        : failure === "promotion" ? "Fingerprint already has a case."
          : "Invalid Flywheel snapshot: promotion does not match the selected correction",
    });
  });

  test("failed correction draft stays selected for a separately authorized retry", async () => {
    const promoted = { ...candidateCases[0]!, id: "case-retry-correction" };
    const dashboard = candidateDashboard({
      corrections: true,
      authorizeDraft: true,
      promote: async () => {
        dashboard.setCorrections(false);
        dashboard.setCandidates([candidateCases[1]!, promoted, candidateCases[0]!]);
        return { code: 0, stdout: JSON.stringify({ schema_version: 1, signal_id: 7, case_id: promoted.id }), stderr: "" };
      },
      draft: async () => {
        dashboard.setCandidates([
          candidateCases[0]!, candidateCases[1]!,
          { ...promoted, latest_draft: { status: "failed", error: "Verifier rejected the change." } },
        ]);
        return { code: 1, stdout: "", stderr: "Verifier rejected the change." };
      },
    });
    await dashboard.start();
    dashboard.press("p");
    await dashboard.waitForOverlay(2);
    expect(dashboard.confirmations).toHaveLength(1);
    expect(dashboard.notices.at(-1)).toEqual({ message: "Verifier rejected the change.", type: "error" });
    expect(dashboard.render().join("\n")).toContain("Candidate 3/3");
    expect(dashboard.render().join("\n")).toContain("Verifier rejected the change.");
    dashboard.press("\u001b[100;1u");
    await dashboard.waitForOverlay(3);
    await dashboard.close();

    expect(dashboard.confirmations).toHaveLength(2);
    expect(dashboard.requests.filter((args) => args.includes("triage-promote"))).toHaveLength(1);
    expect(dashboard.requests.filter((args) => args.includes("draft")).map((args) => args[args.indexOf("--case") + 1])).toEqual([
      promoted.id, promoted.id,
    ]);
  });

  test("ignores correction actions when only candidates exist", async () => {
    const dashboard = candidateDashboard();
    await dashboard.start();
    dashboard.press("p");
    dashboard.press("x");
    await dashboard.close();

    expect(dashboard.confirmations).toHaveLength(0);
    expect(dashboard.requests.some((args) => args.some((arg) => arg.startsWith("triage-")))).toBe(false);
    expect(dashboard.requests.some((args) => args.includes("draft"))).toBe(false);
  });

  test("does not authorize or draft a selected running candidate", async () => {
    const dashboard = candidateDashboard({
      authorizeDraft: true,
      candidates: [
        candidateCases[0]!,
        { ...candidateCases[1]!, latest_draft: { status: "running", error: null } },
      ],
    });
    await dashboard.start();
    dashboard.press("j");
    dashboard.press("d");
    await dashboard.close();

    expect(dashboard.confirmations).toHaveLength(0);
    expect(dashboard.requests.some((args) => args.includes("draft"))).toBe(false);
  });

  test.each([true, false])("does not start correction or candidate drafting while another case runs (%s)", async (corrections) => {
    const dashboard = candidateDashboard({
      corrections,
      authorizeDraft: true,
      candidates: [
        candidateCases[0]!,
        { ...candidateCases[1]!, latest_draft: { status: "running", error: null } },
      ],
    });
    await dashboard.start();
    dashboard.press(corrections ? "p" : "d");
    await dashboard.waitForOverlay(2);
    await dashboard.close();

    expect(dashboard.confirmations).toHaveLength(0);
    expect(dashboard.requests.some((args) => args.includes("triage-propose") || args.includes("triage-promote") || args.includes("draft"))).toBe(false);
    expect(dashboard.notices.at(-1)?.type).toBe("warning");
  });

  test("starts with corrections and switches both ways without applying correction actions to candidates", async () => {
    const dashboard = candidateDashboard({ corrections: true, authorizeDraft: true });
    await dashboard.start();
    dashboard.press("x");
    await dashboard.waitForOverlay(2);
    dashboard.press("\t");
    dashboard.press("p");
    dashboard.press("x");
    expect(dashboard.confirmations).toHaveLength(1);
    dashboard.press("j");
    dashboard.press("d");
    await dashboard.waitForOverlay(3);
    dashboard.press("\t");
    dashboard.press("x");
    await dashboard.waitForOverlay(4);
    await dashboard.close();

    expect(dashboard.requests.filter((args) => args.includes("triage-reject"))).toEqual([
      ["triage-reject", "7"],
      ["triage-reject", "7"],
    ]);
    expect(dashboard.requests.some((args) => args.includes("triage-propose"))).toBe(false);
    expect(dashboard.confirmations[1]?.message).toContain(candidateCases[1]!.diagnosis);
  });

  test("preserves the selected candidate identity when refresh changes ordering", async () => {
    const dashboard = candidateDashboard({ authorizeDraft: true });
    await dashboard.start();
    dashboard.press("j");
    dashboard.setCandidates([candidateCases[1]!, candidateCases[0]!]);
    dashboard.press("r");
    await dashboard.waitForRefresh();
    dashboard.press("d");
    await dashboard.waitForOverlay(2);
    await dashboard.close();

    expect(dashboard.confirmations[0]?.message).toContain(candidateCases[1]!.diagnosis);
  });

  test("moves candidate selection back with k", async () => {
    const dashboard = candidateDashboard({ authorizeDraft: true });
    await dashboard.start();
    dashboard.press("j");
    dashboard.press("k");
    dashboard.press("d");
    await dashboard.waitForOverlay(2);
    await dashboard.close();

    expect(dashboard.confirmations[0]?.message).toContain(candidateCases[0]!.diagnosis);
  });

  test.each(["success", "failure", "throw"] as const)("shows live draft progress and cleans up after %s", async (outcome) => {
    vi.useFakeTimers();
    const clock = spyOn(performance, "now").mockReturnValue(0);
    const started = Promise.withResolvers<string>();
    const completed = Promise.withResolvers<ExecResult>();
    const dashboard = candidateDashboard({
      authorizeDraft: true,
      draft: async (args) => {
        const path = args[args.indexOf("--progress-file") + 1];
        if (!path) throw new Error("draft progress path missing");
        started.resolve(path);
        return completed.promise;
      },
    });
    await dashboard.start();
    dashboard.press("d");
    const path = await started.promise;
    try {
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await writeFile(`${path}.next`, JSON.stringify({
        stage: "Writing evaluation case",
        activity: `\u001b[31mRead\u001b[0m evaluation.ts\u0007\n${"x".repeat(400)}`,
      }), { mode: 0o600 });
      await rename(`${path}.next`, path);
      clock.mockReturnValue(500);
      vi.advanceTimersByTime(500);
      const writing = await dashboard.waitForWidget((lines) => lines[0]!.includes("Writing evaluation case"));
      expect(writing).toHaveLength(2);
      expect(writing[1]).toStartWith("  Read evaluation.ts ");
      expect(writing[1]!.length).toBeLessThanOrEqual(242);
      expect(writing.join("")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(dashboard.widgets.at(-1)?.placement).toBe("belowEditor");

      await writeFile(path, "{incomplete");
      clock.mockReturnValue(1_000);
      vi.advanceTimersByTime(500);
      const elapsed = await dashboard.waitForWidget((lines) => /0:0[1-9] elapsed/.test(lines[0]!));
      expect(elapsed[0]).toContain("Writing evaluation case");
      expect(elapsed[1]).toBe(writing[1]);

      await writeFile(`${path}.next`, JSON.stringify({ stage: "Running evaluations", activity: "Bash: bun test" }), { mode: 0o600 });
      await rename(`${path}.next`, path);
      clock.mockReturnValue(1_500);
      vi.advanceTimersByTime(500);
      await dashboard.waitForWidget((lines) => lines[0]!.includes("Running evaluations") && lines[1]?.includes("Bash: bun test") === true);
      vi.advanceTimersByTime(500);
    } finally {
      if (outcome === "throw") completed.reject(new Error("Draft process could not start."));
      else completed.resolve({
        code: outcome === "success" ? 0 : 1,
        stdout: outcome === "success" ? "Draft complete." : "",
        stderr: outcome === "failure" ? "Evaluation failed: behavior changed." : "",
      });
      await dashboard.waitForOverlay(2);
      await dashboard.close();
    }
    expect(await stat(dirname(path)).then(() => true, () => false)).toBe(false);
    expect(dashboard.notices.at(-1)).toEqual(outcome === "success"
      ? { message: "Draft complete.", type: "info" }
      : outcome === "failure"
        ? { message: "Evaluation failed: behavior changed.", type: "error" }
        : { message: "Draft process could not start.", type: "error" });
    const widgetCount = dashboard.widgets.length;
    vi.advanceTimersByTime(5_000);
    expect(dashboard.widgets).toHaveLength(widgetCount);
    expect(dashboard.widgets.at(-1)?.content?.join(" ")).not.toContain("Running evaluations");
  });
});
