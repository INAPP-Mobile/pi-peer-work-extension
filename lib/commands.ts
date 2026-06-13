// ─── Peer Workflow Command Handlers ──────────────────────────────────────
//
// Command entry points (registerCommand handlers).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { initState, resetState, WorkflowState, readState, getRoleModel } from "./workflow";
import { debugLog } from "./logger";
import { buildDevTask, buildQaMessage } from "./tasks";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Initialize workflow: reset state, copy .gitignore-template, clean stale files.
 */
export function handleInit(ctx: any): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  initState();

  // Copy .gitignore-template over .gitignore (overwrite)
  const templatePath = join(__dirname, "..", ".gitignore-template");
  const gitignorePath = join(process.cwd(), ".gitignore");
  const templateContent = readFileSync(templatePath, "utf-8");
  writeFileSync(gitignorePath, templateContent, "utf-8");

  // Remove all stale workflow files
  const pwDir = join(process.cwd(), ".pworkflow");
  if (existsSync(pwDir)) {
    const staleFiles = [
      "output-dev.txt",
      "output-qa.txt",
      "task-dev.json",
      "task-qa.json",
      "git-init.log",
    ];
    for (const f of staleFiles) {
      const fp = join(pwDir, f);
      if (existsSync(fp)) unlinkSync(fp);
    }
    // Also remove any archived debug logs or old state backups (but keep fresh state.json)
    for (const f of readdirSync(pwDir)) {
      if (f === "state.json") continue;
      if (f.startsWith("debug.log") || f.startsWith("state.")) {
        const fp = join(pwDir, f);
        if (existsSync(fp)) unlinkSync(fp);
      }
    }
  }

  ctx.ui.notify(
    `✅ Peer workflow initialised.\n` +
      `Phase: PLAN\nStep: dev plans\n.gitignore written from template.`,
    "info",
  );
}

/** Show current workflow state. */
export function handleStatus(ctx: any): void {
  const state = readState();
  if (!state) {
    ctx.ui.notify(
      "No active workflow. Run /pworkflow-init first.",
      "warning",
    );
    return;
  }
  // Import helper functions from workflow.ts dynamically
  const { getCurrentStep, WORKFLOW_PHASES } = require("./workflow") as any;
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
  ctx.ui.notify(
    "✅ Workflow state and role cleared. Run /pworkflow-init and /pworkflow-role to start fresh.",
    "info",
  );
}
