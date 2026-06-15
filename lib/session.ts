// ─── Session Event Handlers ──────────────────────────────────────────────
//
// pi.on("session_start"), pi.on("message_end"), pi.on("agent_end") handlers.
// agent_end delegates flow decisions to the workflow engine.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyTransition,
  getCurrentStep,
  getRoleModel,
  readState,
  resolveTransition,
  syncTaskFileMtime,
  writeState,
  writeTaskFile,
  WorkflowState,
} from "./workflow";
import { setupDebugLogging, debugLog } from "./logger";
import { parseWorkflowTags } from "./tags";
import { notifyTelegram } from "./telegram";
import {
  extractLastAgentMessage,
  extractLastAgentMessageFromMessage,
  buildFooter,
  detectRole,
} from "./ui";
import { buildDevTask, buildQaTask } from "./tasks";

export function registerSessionHandlers(pi: ExtensionAPI): void {
  // ─── Session Start ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    setupDebugLogging();

    let state = readState();
    if (!state) return;

    const role = detectRole() || state.role;
    ctx.ui.setFooter(buildFooter(ctx, () => role));

    debugLog(`[session_start] MY_ROLE=${role}`);

    // Restore stored model for this role
    if (state.role) {
      try {
        const storedModelId = getRoleModel(state.role, state);
        if (storedModelId && ctx.model?.id !== storedModelId) {
          debugLog(
            `[session_start] looking up stored model '${storedModelId}' for ${state.role}`,
          );
          const available = await ctx.modelRegistry.getAvailable();
          const model = available.find((m: any) => m.id === storedModelId);
          if (model) {
            const switched = await pi.setModel(model);
            if (switched) {
              debugLog(
                `[session_start] model switched to ${model.id} for ${state.role}`,
              );
            } else {
              ctx.ui.notify(
                `⚠️ Could not switch to stored model '${model.id}' for ${state.role} (no API key?). Current: ${ctx.model?.id ?? "unknown"}`,
                "warning",
              );
            }
          } else {
            debugLog(
              `[session_start] stored model '${storedModelId}' not found in ${available.length} available models`,
            );
            ctx.ui.notify(
              `⚠️ Stored model '${storedModelId}' for ${state.role} not available.\nCurrent: ${ctx.model?.id ?? "unknown"}. Use /pworkflow-role ${state.role} <model> to set.`,
              "warning",
            );
          }
        }
      } catch (err) {
        debugLog(`[session_start] error restoring model: ${err}`);
      }
    }

    if (!state.context?.humanGoal) {
      debugLog("[session_start] no goal, injecting task silently");
      return;
    }
  });

  // ─── message end ─────────────────────────────────────────────────────
  pi.on("message_end", async (event, _ctx) => {
    const state = readState();
    if (state == null || !state.role) return;

    const lastMsg = extractLastAgentMessageFromMessage(event.message);
    if (!lastMsg) return;

    debugLog("[message_end] last Msg", lastMsg);
    const scores = parseWorkflowTags(lastMsg);

    // Store only navigation metadata and scores. Artifact content stays in files.
    state.context.lastAgentMessage =
      lastMsg.substring(0, 200) + (lastMsg.length > 200 ? "..." : "");

    if (scores && scores.devScore !== undefined) {
      state.context.devScore = scores.devScore;
    }
    if (scores && scores.qaScore !== undefined) {
      state.context.qaScore = scores.qaScore;
    }

    if (scores.devScore === undefined && scores.qaScore === undefined) {
      debugLog("[message_end] No score found in message");
      return;
    }

    debugLog("[message_end] Score found in message", scores);
    writeState(state);
  });

  // ─── Agent End ────────────────────────────────────────────────────
  pi.on("agent_end", async (event, ctx) => {
    const state = readState();
    if (!state || !state.role) return;

    const lastMsg = extractLastAgentMessage(event);

    const errorEvent = event as any;
    const errorMessage = errorEvent?.errorMessage;
    if (!lastMsg || errorMessage) {
      debugLog(`[agent_end] turn errored: ${errorMessage}`);
      reinjectTask(pi, state);
      return;
    }

    debugLog(`[agent_end] turn_end: state.role=${state.role}`);

    const parsed = parseWorkflowTags(lastMsg);
    const transition = resolveTransition(state, {
      ...parsed,
      rawMessage: lastMsg,
    });

    if (transition.type === "reinject-current-step") {
      debugLog(`[agent_end] ${transition.reason}`);
      applyTransition(state, transition);
      reinjectTask(pi, state);
      return;
    }

    applyTransition(state, transition);

    if (transition.type === "blocked") {
      ctx.ui.notify(
        `[pworkflow] workflow blocked. Notifying human via Telegram...`,
        "warning",
      );
      const notification = await notifyTelegram(
        `🚨 pworkflow blocked\nStep: ${transition.step.id}\nRole: ${state.role}\n\n${lastMsg.substring(0, 1000)}`,
      );
      ctx.ui.notify(
        notification.ok
          ? "✅ Telegram notification sent."
          : `⚠️ Telegram notification failed: ${notification.error}`,
        notification.ok ? "info" : "warning",
      );
      return;
    }

    if (transition.type === "complete") {
      ctx.ui.notify(`✅ [pworkflow] ${transition.message}`, "info");
      return;
    }

    const nextRole = transition.nextRole;
    ctx.ui.setFooter(buildFooter(ctx, () => nextRole));
    ctx.ui.notify(`[pworkflow] ${transition.message}`, "info");
    debugLog(`[agent_end] next role after compact will be ${nextRole}`);

    pi.sendUserMessage("run pworkflow-compact", { deliverAs: "followUp" });
  });

  // ─── Session Shutdown ────────────────────────────────────────────
  pi.on("session_shutdown", (_event, _ctx) => {
    // poller.stop();
  });
}

function reinjectTask(pi: ExtensionAPI, state: WorkflowState): void {
  const role = state.role;
  const task = role === "dev" ? buildDevTask(state) : buildQaTask(state);
  const step = getCurrentStep(state);
  const reason = `No required [${step.scoreTag}:N] score detected for ${step.id}.`;

  writeTaskFile(role, task);
  syncTaskFileMtime(role);

  pi.sendUserMessage(
    `⚠️ The previous turn unsuccessfully completed.\n\n${reason}\n\nHere's your task again:\n\n${task}`,
    { deliverAs: "followUp" },
  );
}
