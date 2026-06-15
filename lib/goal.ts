// ─── Goal Command Handler ────────────────────────────────────────────────
//
// /pworkflow-goal command implementation.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readState, writeState, writeTaskFile, syncTaskFileMtime } from "./workflow";
import { buildDevMessage, buildDevTask } from "./tasks";

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

  // If it's dev's turn, inject updated task with the goal.
  if (state.role === "dev") {
    try {
      writeTaskFile("dev", buildDevTask(state));
      syncTaskFileMtime("dev");
      pi.sendUserMessage(buildDevMessage(), { deliverAs: "followUp" });
    } catch (e) {
      ctx.ui.notify(`⚠️ Failed to update dev task: ${e}`, "warning");
    }
  }
}
