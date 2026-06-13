/**
 * Peer Workflow Extension — async build/release pipeline between dev and qa.
 *
 * Two-phase workflow:
 *   BUILD  → dev builds → qa reviews  → [SUCCESS]→RELEASE  [FAILURE]→dev  [BLOCKER]→Telegram
 *   RELEASE → dev deploys+publishes → qa confirms → [SUCCESS]→done+Telegram  [FAILURE]→dev  [BLOCKER]→Telegram
 *
 * Entry point — wires together sub-modules and registers pi hooks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Command handlers
import { handleInit, handleStatus, handleReset } from "./lib/commands";
import { registerTools } from "./lib/tools";
import { registerSessionHandlers } from "./lib/session";
import { handleRole } from "./lib/role";
import { handleGoal } from "./lib/goal";

export default function (pi: ExtensionAPI) {
  // ─── Commands ─────────────────────────────────────────────────────

  pi.registerCommand("pworkflow-init", {
    description:
      "Initialise a new peer workflow pipeline. Resets any existing state. " +
      "Usage: /pworkflow-init",
    handler: async (_args: unknown, ctx) => {
      handleInit(ctx);
    },
  });

  pi.registerCommand("pworkflow-status", {
    description: "Show current peer workflow state. Usage: /pworkflow-status",
    handler: async (_args: unknown, ctx) => {
      handleStatus(ctx);
    },
  });

  pi.registerCommand("pworkflow-reset", {
    description: "Reset the peer workflow completely. Usage: /pworkflow-reset",
    handler: async (_args: unknown, ctx) => {
      handleReset(ctx);
    },
  });

  pi.registerCommand("pworkflow-goal", {
    description:
      "Set the project goal/requirements for the workflow. " +
      "Usage: /pworkflow-goal <description>",
    handler: async (args: string, ctx) => {
      handleGoal(pi, args, ctx);
    },
  });

  pi.registerCommand("pworkflow-role", {
    description:
      "Set your role: dev or qa, optionally with a model. Usage: /pworkflow-role [dev|qa] [model]",
    handler: async (args: string, ctx) => {
      await handleRole(args, ctx);
    },
  });

  // ─── Tools ────────────────────────────────────────────────────────

  registerTools(pi);

  // ─── Session Event Handlers ───────────────────────────────────────

  registerSessionHandlers(pi);
}
