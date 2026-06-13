// ─── Peer Workflow Tools ──────────────────────────────────────────────────
//
// Tool handlers (registerTool).

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  readState,
  writeState,
  resetState,
  clearTaskFile,
  writeTaskFile,
  syncTaskFileMtime,
} from "./workflow";
import { notifyTelegram } from "./telegram";
import { debugLog } from "./logger";
import { buildFooter } from "./ui";
import {
  buildDevMessage,
  buildDevTask,
  buildQaMessage,
  buildQaTask,
} from "./tasks";

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pworkflow-compact",
    label: "Compact session (nuke to ~0)",
    description:
      "Reset workflow context and achieve near-zero conversation tokens like /new",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      // Trigger compaction which will be cancelled by session_before_compact
      ctx.compact({
        customInstructions:
          "Near-zero token compaction - clear conversation context",
        onComplete: () => {
          var state = readState();
          if (!state) {
            debugLog("[compact] no state to update");
            pi.sendUserMessage("no state to update error report to human", {
              deliverAs: "followUp",
            });
            return;
          }
          debugLog(`[compact] switching to ${state.nextRole}`);

          clearTaskFile(state.role);
          writeTaskFile(state.nextRole, buildQaTask(state));
          syncTaskFileMtime(state.nextRole);

          state.role = state.nextRole;
          state.nextRole = state.role === "dev" ? "qa" : "dev";
          ctx.ui.setFooter(buildFooter(ctx, () => state?.role ?? null));
          writeState(state);
          pi.sendUserMessage(buildQaMessage(), { deliverAs: "followUp" });
        },
        onError: (error) => {
          pi.sendUserMessage("compaction error report to human", {
            deliverAs: "followUp",
          });
          debugLog(`[compact] compaction error (expected): ${error.message}`);
        },
      });

      return {
        content: [
          {
            type: "text",
            text: `workflow context reset for near-zero conversation tokens`,
          },
        ],
        details: { tool: "pworkflow-compact" },
      };
    },
  });

  pi.registerTool({
    name: "pworkflow-notify",
    label: "Telegram Notification",
    description:
      "Send a notification to the human via Telegram. Uses settings from .pworkflow/settings.json.",
    parameters: Type.Object({
      message: Type.String({ description: "The notification message content" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = readState();
      if (!state) {
        return {
          content: [
            {
              type: "text",
              text: "❌ No active peer workflow. Run /pworkflow-init first.",
            },
          ],
          details: { tool: "pworkflow-notify" },
          isError: true,
        };
      }
      const result = await notifyTelegram(params.message);
      if (result.ok) {
        return {
          content: [{ type: "text", text: "✅ Telegram notification sent." }],
          details: { tool: "pworkflow-notify" },
        };
      }
      return {
        content: [{ type: "text", text: `❌ ${result.error}` }],
        isError: true,
        details: { tool: "pworkflow-notify" },
      };
    },
  });
}
