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
import { Type } from "typebox";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readState,
  writeState,
  initState,
  resetState,
  getCurrentStep,
  advancePhase,
  markCompleted,
  writeTaskFile,
  clearTaskFile,
  getRoleModel,
  setRoleModel,
  DEFAULT_CONFIDENCE_THRESHOLD,
  WorkflowState,
  WORKFLOW_PHASES,
} from "./lib/workflow";
import { notifyTelegram } from "./lib/telegram";
import { debugLog, setupDebugLogging } from "./lib/logger";
import { handleQaTurnEnd } from "./lib/decision";
import {
  buildDevTask,
  buildQaTask,
  buildDevMessage,
  buildQaMessage,
} from "./lib/tasks";
import { parseScores } from "./lib/tags";
import { createPoller, syncTaskFileMtime } from "./lib/polling";
import {
  detectRole,
  buildFooter,
  extractLastMessage,
  extractLastAgentMessage,
  extractLastAgentMessageFromMessage,
} from "./lib/ui";
import { judgeOutput } from "./lib/qualifier";
import { X509Certificate } from "node:crypto";
import { initCompact } from "./lib/compact";

export default function (pi: ExtensionAPI) {
  // ─── Aggressive compaction setup ────────────────────────────────
  initCompact(pi);

  // const poller = createPoller({
  //   sendUserMessage(text, opts) {
  //     pi.sendUserMessage(text, opts as any);
  //   },
  // });

  // ─── Commands ─────────────────────────────────────────────────────

  pi.registerCommand("pworkflow-init", {
    description:
      "Initialise a new peer workflow pipeline. Resets any existing state. " +
      "Usage: /pworkflow-init",
    handler: async (_args: unknown, ctx) => {
      initState();

      // Copy .gitignore-template over .gitignore (overwrite)
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const templatePath = join(__dirname, ".gitignore-template");
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
    },
  });

  pi.registerCommand("pworkflow-status", {
    description: "Show current peer workflow state. Usage: /pworkflow-status",
    handler: async (_args: unknown, ctx) => {
      const state = readState();
      if (!state) {
        ctx.ui.notify(
          "No active workflow. Run /pworkflow-init first.",
          "warning",
        );
        return;
      }
      const step = getCurrentStep(state);
      ctx.ui.notify(
        `📋 Workflow Status\n` +
          `Phase: ${state.phase.toUpperCase()}\n` +
          `Status: ${state.status}\n` +
          `Current Step: ${step.description} (${step.role})\n` +
          `Step Index: ${state.stepIndex}/${WORKFLOW_PHASES.length - 1}\n` +
          `Started: ${new Date(state.startedAt).toISOString()}`,
        "info",
      );
    },
  });

  pi.registerCommand("pworkflow-reset", {
    description: "Reset the peer workflow completely. Usage: /pworkflow-reset",
    handler: async (_args: unknown, ctx) => {
      resetState();
      ctx.ui.notify(
        "✅ Workflow state and role cleared. Run /pworkflow-init and /pworkflow-role to start fresh.",
        "info",
      );
    },
  });

  pi.registerCommand("pworkflow-goal", {
    description:
      "Set the project goal/requirements for the workflow. " +
      "Usage: /pworkflow-goal <description>",
    handler: async (args: string, ctx) => {
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
        ctx.ui.notify(
          "No workflow state. Run /pworkflow-init first.",
          "warning",
        );
        return;
      }

      state.context.humanGoal = args.trim();
      writeState(state);

      ctx.ui.notify(`✅ Project goal set.`, "info");

      // If it's dev's turn, inject updated task with the goal
      if (state.role === "dev") {
        const task = buildDevTask(state);
        writeTaskFile("dev", task);
        syncTaskFileMtime("dev");
        debugLog(`[pworkflow] dev task written (${task.length} bytes)`);
        pi.sendUserMessage(buildDevMessage(), { deliverAs: "followUp" });
      }
    },
  });

  pi.registerCommand("pworkflow-role", {
    description:
      "Set your role: dev or qa, optionally with a model. Usage: /pworkflow-role [dev|qa] [model]",
    handler: async (args: string, ctx) => {
      const parts = args.trim().split(/\s+/);
      const role = parts[0]?.toLowerCase();
      const modelArg = parts.slice(1).join("/");

      if (role !== "dev" && role !== "qa") {
        ctx.ui.notify("Usage: /pworkflow-role dev|qa [model]", "error");
        return;
      }

      debugLog(`[pworkflow] Role set to ${role}`);
      ctx.ui.setFooter(buildFooter(ctx, () => role));

      const state = readState();
      if (!state) return;

      if (modelArg) {
        const parts = modelArg.split("/");
        let model =
          parts.length === 2
            ? ctx.modelRegistry.find(parts[0], parts[1])
            : undefined;
        if (!model) {
          const available = await ctx.modelRegistry.getAvailable();
          model = available.find((m) => m.id === modelArg);
        }
        if (model) {
          setRoleModel(role, model.id, state);
          const switched = await pi.setModel(model);
          debugLog(
            `[pworkflow] role model set: ${model.id}, switched=${switched}`,
          );
          ctx.ui.notify(
            switched
              ? `✅ Role '${role}' → model '${model.id}'`
              : `✅ Model '${model.id}' saved for ${role} but no API key available`,
            switched ? "info" : "warning",
          );
        } else {
          ctx.ui.notify(
            `⚠️ Model '${modelArg}' not found. Role set without model.`,
            "warning",
          );
        }
      } else {
        // No model arg — restore previously stored model for this role
        const storedModelId = getRoleModel(role, state);
        if (storedModelId && ctx.model?.id !== storedModelId) {
          const available = await ctx.modelRegistry.getAvailable();
          const model = available.find((m) => m.id === storedModelId);
          if (model) {
            const switched = await pi.setModel(model);
            ctx.ui.notify(
              switched
                ? `✅ Role '${role}' → restored model '${model.id}'`
                : `✅ Role '${role}' set, but model '${model.id}' saved without API key`,
              switched ? "info" : "warning",
            );
          } else {
            ctx.ui.notify(
              `✅ Role set to '${role}'. (Stored model '${storedModelId}' not available)`,
              "info",
            );
          }
        } else {
          ctx.ui.notify(`✅ Role set to '${role}'.`, "info");
        }
      }
    },
  });

  // ─── Tool ─────────────────────────────────────────────────────────

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
            pi.sendUserMessage(buildDevMessage(), {
              deliverAs: "followUp",
            });
          } else if (state?.role === "qa") {
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

  // ─── Session Start ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    setupDebugLogging();

    // Load / init workflow state
    let state = readState();
    if (!state) return;

    // Register footer always — MY_ROLE may be set later via /pworkflow-role
    ctx.ui.setFooter(buildFooter(ctx, () => state.role));

    debugLog(`[pworkflow] session_start: MY_ROLE=${state.role}`);

    // Restore stored model for this role
    if (state.role) {
      try {
        const storedModelId = getRoleModel(state.role, state);
        if (storedModelId && ctx.model?.id !== storedModelId) {
          debugLog(
            `[pworkflow] looking up stored model '${storedModelId}' for ${state.role}`,
          );
          const available = await ctx.modelRegistry.getAvailable();
          const model = available.find((m) => m.id === storedModelId);
          if (model) {
            const switched = await pi.setModel(model);
            if (switched) {
              debugLog(
                `[pworkflow] model switched to ${model.id} for ${state.role}`,
              );
            } else {
              ctx.ui.notify(
                `⚠️ Could not switch to stored model '${model.id}' for ${state.role} (no API key?). Current: ${ctx.model?.id ?? "unknown"}`,
                "warning",
              );
            }
          } else {
            debugLog(
              `[pworkflow] stored model '${storedModelId}' not found in ${available.length} available models`,
            );
            ctx.ui.notify(
              `⚠️ Stored model '${storedModelId}' for ${state.role} not available.\nCurrent: ${ctx.model?.id ?? "unknown"}. Use /pworkflow-role ${state.role} <model> to set.`,
              "warning",
            );
          }
        }
      } catch (err) {
        debugLog(`[pworkflow] error restoring model: ${err}`);
      }
    }

    if (!state.context?.humanGoal) {
      debugLog("[pworkflow] no goal, injecting task silently");
      return;
    }

    // Always start poller for this session's role to catch task file changes
    // poller.start(state.role);

    if (state.role === "dev") {
      const devTask = buildDevTask(state);
      writeTaskFile("dev", devTask);
      syncTaskFileMtime("dev");
      pi.sendUserMessage(buildDevMessage(), { deliverAs: "followUp" });
    } else if (state.role === "qa") {
      const qaTask = buildQaTask(state);
      writeTaskFile("qa", qaTask);
      syncTaskFileMtime("qa");
      pi.sendUserMessage(buildQaMessage(), { deliverAs: "followUp" });
    }
  });

  // ─── message end ─────────────────────────────────────────────────────
  pi.on("message_end", async (event, ctx) => {
    var state = readState();
    if (state == null || !state.role) return;

    // message_end has event.message (single), not event.messages (array)
    let lastMsg = extractLastAgentMessageFromMessage(event.message);
    if (!lastMsg) {
      debugLog("[message_end] No lastMsg found in event.message");
      return;
    }

    debugLog("[message_end] lastMsg", lastMsg);
    var scoreExists = false;
    const scores = parseScores(lastMsg);
    if (scores && scores.devScore !== undefined) {
      state.context.devScore = scores.devScore;
      scoreExists = true;
    }
    if (scores && scores.qaScore !== undefined) {
      state.context.qaScore = scores.qaScore;
      scoreExists = true;
    }

    if (!scoreExists) {
      debugLog("[message_end] No score found in message");
      return;
    }
    debugLog("[message_end] Score found in message", scores);
    writeState(state);
  });

  // ─── Agent End ────────────────────────────────────────────────────
  // agent_end fires once per user prompt, after ALL tool call turns complete.
  // This prevents processing intermediate tool-call turns as if they were final output.

  pi.on("agent_end", async (event, ctx) => {
    var state = readState();
    if (state == null || !state.role) return;

    let lastMsg = extractLastAgentMessage(event);

    // Turn timed out or errored — no valid output
    const errorEvent = event as any;
    const errorMessage = errorEvent?.errorMessage;
    if (!lastMsg || errorMessage) {
      debugLog(`[pworkflow] turn errored: ${errorMessage}`);
      // Re-inject task for retry (don't advance state)
      reinjectTask(state);
      return;
    }

    debugLog(`[pworkflow] turn_end: state.role=${state.role}`);

    const scores = parseScores(lastMsg);
    if (
      (scores && state.role === "dev" && scores.devScore === undefined) ||
      (scores && state.role === "qa" && scores.qaScore === undefined)
    ) {
      // if scores are missing for the current role, reinject task
      reinjectTask(state);
      return;
    }

    var scoreExists = false;
    if (scores && scores.devScore !== undefined) {
      state.context.devScore = scores.devScore;
      scoreExists = true;
    }
    if (scores && scores.qaScore !== undefined) {
      state.context.qaScore = scores.qaScore;
      scoreExists = true;
    }
    if (scoreExists) {
      debugLog("[agent_end] Score found in message", scores);
      writeState(state);
    } else {
      debugLog("[agent_end] No score found in message", scores);
    }

    const scoreSum =
      (state.context.devScore ?? 0) + (state.context.qaScore ?? 0);
    const threshold = state.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

    if (scoreSum >= threshold) {
      const newState = advancePhase(state);
      if (newState === null) {
        ctx.ui.notify(`✅ [pworkflow] goal completed successfully!!`, "success");
        markCompleted(state);
        return;
      }
      state = newState;
      ctx.ui.notify(
        `[pworkflow] threshold met, advancing to next phase: ${state.phase} (${scoreSum} >= ${threshold})`,
        "info",
      );
      state.context.devScore = 0;
      state.context.qaScore = 0;
      writeState(state);

      // Write build task for dev immediately
      const buildTask = buildDevTask(state);
      writeTaskFile("dev", buildTask);
      syncTaskFileMtime("dev");
      pi.sendUserMessage(buildDevMessage(), {
        deliverAs: "followUp",
      });
      return;
    } else {
      ctx.ui.notify(
        `[pworkflow] threshold NOT met, continue to revise (${scoreSum} < ${threshold})`,
        "info",
      );
    }

    if (state.role === "dev") {
      clearTaskFile("dev");
      writeTaskFile("qa", buildQaTask(state));
      syncTaskFileMtime("qa");

      state.role = "qa";
      ctx.ui.setFooter(buildFooter(ctx, () => "qa"));
      writeState(state);
    } else if (state.role === "qa") {
      clearTaskFile("qa");
      writeTaskFile("dev", buildDevTask(state));
      syncTaskFileMtime("dev");

      state.role = "dev";
      ctx.ui.setFooter(buildFooter(ctx, () => "dev"));
      writeState(state);
    }
  });

  // ─── Session Shutdown ────────────────────────────────────────────

  pi.on("session_shutdown", (_event, _ctx) => {
    // poller.stop();
  });

  function reinjectTask(state: WorkflowState) {
    const task =
      state.role === "dev" ? buildDevTask(state) : buildQaTask(state);
    writeTaskFile(state.role, task);
    syncTaskFileMtime(state.role);
    pi.sendUserMessage(
      `⚠️ The previous turn unsuccessfully completed. Here\'s your task again:\n\n${task}`,
      { deliverAs: "followUp" },
    );
  }
}
