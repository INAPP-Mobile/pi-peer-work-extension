// ─── Peer Workflow Tools ──────────────────────────────────────────────────
//
// Tool handlers (registerTool).

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readState } from "./workflow";
import { buildDevMessage, buildQaMessage } from "./tasks";
import { notifyTelegram } from "./telegram";
import { debugLog } from "./logger";

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pworkflow-compact",
    label: "Compact session",
    description: "Compact the session",
    parameters: Type.Object({
      message: Type.String({
        description:
          "The custom instructions to use when compacting the session",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.compact({
        customInstructions: params.message,
        onComplete: () => {
          const state = readState();
          if (state?.role === "dev") {
            debugLog("after compaction dev role: sending dev message");
            pi.sendUserMessage(buildDevMessage(), {
              deliverAs: "followUp",
            });
          } else if (state?.role === "qa") {
            debugLog("after compaction qa role: sending qa message");
            pi.sendUserMessage(buildQaMessage(), {
              deliverAs: "followUp",
            });
          }
        },
        onError: (error) => {
          pi.sendUserMessage(
            `Error compacting session: report to human: ${error.message}`,
            {
              deliverAs: "followUp",
            },
          );
        },
      });

      return {
        content: [{ type: "text", text: `session compacted` }],
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
