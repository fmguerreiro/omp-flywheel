# OMP Flywheel

Interactive Agent Flywheel triage and candidate-draft dashboard for OMP.

## Install

Install this package as an OMP plugin. Its `package.json` exposes the extension through the `omp.extensions` manifest field:

```json
{
  "omp": {
    "extensions": ["./src/index.ts"]
  }
}
```

Set `AGENT_FLYWHEEL_CLI` when the snapshot executable is not named `agent-flywheel`:

```sh
export AGENT_FLYWHEEL_CLI=/path/to/agent-flywheel
```

## Dashboard

Use `/flywheel` or `Ctrl+Shift+F` in the interactive TUI. With no open corrections, the dashboard opens directly on saved candidates. Each candidate shows its proposed behavior change, severity, latest draft status and error, and next step. Use `j`/`k` to select a candidate and `d` to draft that selection—no case ID entry. The confirmation explains that passing evaluations automatically commit and push to `origin/main`, with no second approval. A running draft cannot be started again; failed or blocked drafts can be retried. The view loads up to 20 candidates and shows loaded versus total counts when more exist.

While a selected draft runs, the dashboard closes and the status widget shows the backend's current phase, latest model or tool activity, and elapsed time. There is no estimated percentage. This requires a Flywheel CLI supporting `draft --progress-file PATH`; the extension polls a bounded JSON progress file in a private temporary directory while the existing command runs, then stops polling and removes the directory before refreshing the dashboard. Drafts retain the 15-minute command timeout and report completion or failure through notifications.

When both corrections and candidates exist, press Tab to switch views. In Corrections, use `j`/`k` to select, `x` to reject, or `p` to analyze. Flywheel uses the current OMP model to generate a suggested behavior change, severity, and internal grouping label from the full stored evidence. Analysis alone changes no files or saved corrections. One confirmation of the proposal authorizes writing a change in an isolated checkout, evaluation, and automatic commit/push to `origin/main` only if checks pass. Saving the candidate happens internally; its exact ID comes from `triage-promote --json`, and drafting starts immediately without another confirmation or candidate action. Progress stays visible below the restored editor. A failed draft leaves the saved candidate selected for retry, which requires a new confirmation. This requires a Flywheel CLI supporting the versioned promotion response (`schema_version: 1`, `signal_id`, `case_id`). Without a selected session model, analysis inherits Flywheel's runner configuration; the built-in runner inherits OMP's configured default unless explicitly overridden.

Press `r` to refresh or Escape to close. The dashboard renders inline directly below the Flywheel status, replacing the editor while open rather than floating at the bottom of the terminal. Closing restores the editor and any unsent text, with the status widget back below it. The dashboard closes before dialogs, then returns after completion or cancellation. Both legacy and Kitty keyboard protocol input are supported. At main-session start, the extension reads a bounded snapshot, open correction details, and candidate descriptions. Theme-coloured cards preserve Markdown and diff structure in prior responses. The status widget appears only for durable work needing attention.

A draft marked `fixed` has already been published and needs no review. Successful drafts and passing evaluations do not keep the status widget visible. Active cases count existing evaluation coverage, not improvements awaiting review.
