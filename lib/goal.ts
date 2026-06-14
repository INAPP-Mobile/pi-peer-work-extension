// ─── Goal Command Handler ────────────────────────────────────────────────
//
// /pworkflow-goal command implementation.

import { readState, writeState, PW_DIR } from "./workflow";
import { buildDevMessage, buildDevTask } from "./tasks";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

export function handleGoal(pi: ExtensionAPI, args: string, ctx: any): void {
  if (!args.trim()) {
    const state = readState();
    if (state?.context.humanGoal) {
      ctx.ui.notify(`Current goal: ${state.context.humanGoal}`, "info");
    } else {
      ctx.ui.notify(
        "Usage: /pworkflow-goal <project description>\n" +
          "e.g., /pworkflow-goal Build a REST API for a todo app with user auth",
        "info",
      );
    }
    return;
  }

  const state = readState();
  if (!state) {
    ctx.ui.notify("No workflow state. Run /pworkflow-init first.", "warning");
    return;
  }

  state.context.humanGoal = args.trim();
  writeState(state);

  ctx.ui.notify(`✅ Project goal set.`, "info");

  // If it's dev's turn, inject updated task with the goal
  if (state.role === "dev") {
    const pwDir = PW_DIR();
    const devTaskPath = join(pwDir, "task-dev.json");
    try {
      if (!existsSync(pwDir)) {
        mkdirSync(pwDir, { recursive: true });
      }
      writeFileSync(
        devTaskPath,
        JSON.stringify(
          { task: buildDevTask(state), assignedAt: Date.now() },
          null,
          2,
        ),
      );
      pi.sendUserMessage(buildDevMessage(), { deliverAs: "followUp" });
    } catch (e) {
      ctx.ui.notify(`⚠️ Failed to update dev task: ${e}`, "warning");
    }
  }
}

import { join } from "node:path";
import { ExtensionAPI } from "@earendil-works/pi-coding-agent";
