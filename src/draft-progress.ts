import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

function progressText(value: string, limit: number): string {
  const text = stripVTControlCharacters(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export async function startDraftProgress(render: (lines: string[]) => void): Promise<{
  path: string;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "omp-flywheel-draft-"));
  const path = join(directory, "progress.json");
  try {
    await writeFile(path, JSON.stringify({ stage: "Starting draft", activity: "" }), { mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const started = performance.now();
  const buffer = Buffer.alloc(16_385);
  let stage = "Starting draft";
  let activity = "";
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();

  function update(): void {
    const seconds = Math.floor((performance.now() - started) / 1_000);
    const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    render([`Flywheel · ${stage} · ${elapsed} elapsed`, ...(activity ? [`  ${activity}`] : [])]);
  }

  async function poll(): Promise<void> {
    try {
      const file = await open(path, "r");
      try {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead <= 16_384) {
          const value: unknown = JSON.parse(buffer.toString("utf8", 0, bytesRead));
          if (value !== null && typeof value === "object" && "stage" in value && typeof value.stage === "string") {
            const nextStage = progressText(value.stage, 100);
            if (nextStage) {
              stage = nextStage;
              activity = "activity" in value && typeof value.activity === "string" ? progressText(value.activity, 240) : "";
            }
          }
        }
      } finally {
        await file.close();
      }
    } catch {
      // Progress reporting must not interrupt an in-flight draft.
    }
    if (closed) return;
    update();
    timer = setTimeout(() => { pending = poll(); }, 500);
  }

  try {
    update();
    timer = setTimeout(() => { pending = poll(); }, 500);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    path,
    async close() {
      closed = true;
      clearTimeout(timer);
      try {
        await pending;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
