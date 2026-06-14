// ─── Peer Workflow Command Handlers ──────────────────────────────────────
//
// Command entry points (registerCommand handlers).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import {
  initState,
  resetState,
  readState,
  getCurrentStep,
  WORKFLOW_PHASES,
} from "./workflow";

const GITIGNORE_ENTRIES = [".pworkflow/"];

const STALE_PWORKFLOW_FILES = [
  "task-dev.json",
  "task-qa.json",
  "task-order.json",
  "git-init.log",
];

const STALE_ROOT_FILES = [
  "plan.md",
  "qa-review.md",
  "build-output.md",
  "release-output.md",
];

function hasGitignoreEntry(current: string, entry: string): boolean {
  return current
    .split(/\r?\n/)
    .some((line) => line.trim() === entry);
}

function ensureGitignoreEntries(): void {
  const gitignorePath = join(process.cwd(), ".gitignore");
  const current = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf-8")
    : "";
  const missing = GITIGNORE_ENTRIES.filter(
    (entry) => !hasGitignoreEntry(current, entry),
  );
  if (missing.length > 0) {
    writeFileSync(
      gitignorePath,
      `${current.trimEnd()}

# pworkflow
${missing.join("\n")}
`,
      "utf-8",
    );
  }
}

function cleanupWorkflowArtifacts(): void {
  const pwDir = join(process.cwd(), ".pworkflow");
  for (const f of STALE_PWORKFLOW_FILES) {
    const fp = join(pwDir, f);
    if (existsSync(fp)) {
      try {
        unlinkSync(fp);
      } catch {}
    }
  }

  for (const f of STALE_ROOT_FILES) {
    const fp = join(process.cwd(), f);
    if (existsSync(fp)) {
      try {
        unlinkSync(fp);
      } catch {}
    }
  }

  if (existsSync(pwDir)) {
    for (const f of readdirSync(pwDir)) {
      if (f === "state.json" || f === "settings.json") continue;
      if (f.startsWith("debug.log") || f.startsWith("state.")) {
        const fp = join(pwDir, f);
        try {
          unlinkSync(fp);
        } catch {}
      }
    }
  }

  const legacyDir = join(pwDir, ".pworkflow");
  if (existsSync(legacyDir)) {
    for (const f of readdirSync(legacyDir)) {
      if (f === "state.json" || f === "settings.json") continue;
      const fp = join(legacyDir, f);
      try {
        unlinkSync(fp);
      } catch {}
    }
  }

  const docDir = join(process.cwd(), "doc");
  if (existsSync(docDir)) {
    for (const f of readdirSync(docDir)) {
      if (!/^task-\d+\.md$/.test(f)) continue;
      const fp = join(docDir, f);
      try {
        unlinkSync(fp);
      } catch {}
    }
  }
}

/**
 * Initialize workflow: reset state, ensure .gitignore entries, clean stale files.
 */
export function handleInit(ctx: any): void {
  initState();

  ensureGitignoreEntries();
  cleanupWorkflowArtifacts();

  ctx.ui.notify(
    `✅ Peer workflow initialised.\n` +
      `Phase: PLAN\nStep: dev plans\n.gitignore entries ensured; stale workflow artifacts cleared.`,
    "info",
  );
}

/** Show current workflow state. */
export function handleStatus(ctx: any): void {
  const state = readState();
  if (!state) {
    ctx.ui.notify("No active workflow. Run /pworkflow-init first.", "warning");
    return;
  }
  // Helpers are imported statically from workflow.ts.
  const step = getCurrentStep(state);
  ctx.ui.notify(
    `📋 Workflow Status\n` +
      `Phase: ${state.phase.toUpperCase()}\n` +
      `Status: ${state.status}\n` +
      `Current Step: ${step.description}\n` +
      `Step Index: ${state.stepIndex}/${WORKFLOW_PHASES.length - 1}\n` +
      `Started: ${new Date(state.startedAt).toISOString()}`,
    "info",
  );
}

/** Reset workflow state and role. */
export function handleReset(ctx: any): void {
  resetState();
  cleanupWorkflowArtifacts();
  ctx.ui.notify(
    "✅ Workflow state and role cleared. Run /pworkflow-init and /pworkflow-role to start fresh.\nStale workflow artifacts cleared.",
    "info",
  );
}
