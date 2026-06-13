// ─── Session Event Handlers ──────────────────────────────────────────────
//
// pi.on("session_start"), pi.on("message_end"), pi.on("agent_end") handlers.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  readState,
  writeState,
  markCompleted,
  advancePhase,
  advanceSubtask,
  clearTaskFile,
  getRoleModel,
  syncTaskFileMtime,
} from "./workflow";
import { setupDebugLogging, debugLog } from "./logger";
import { parseScores } from "./tags";
import {
  extractLastAgentMessage,
  extractLastAgentMessageFromMessage,
  buildFooter,
  detectRole,
} from "./ui";

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
  pi.on("message_end", async (event, ctx) => {
    var state = readState();
    if (state == null || !state.role) return;

    let lastMsg = extractLastAgentMessageFromMessage(event.message);
    if (!lastMsg) {
      return;
    }

    debugLog("[message_end] last Msg", lastMsg);
    var scoreExists = false;
    const scores = parseScores(lastMsg);

    // Store last message for error reporting
    state.context.lastAgentMessage =
      lastMsg.substring(0, 200) + (lastMsg.length > 200 ? "..." : "");

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
  pi.on("agent_end", async (event, ctx) => {
    var state = readState();
    if (!state || !state.role) return;

    let lastMsg = extractLastAgentMessage(event);

    const errorEvent = event as any;
    const errorMessage = errorEvent?.errorMessage;
    if (!lastMsg || errorMessage) {
      debugLog(`[agent_end] turn errored: ${errorMessage}`);
      reinjectTask(pi, state);
      return;
    }

    debugLog(`[agent_end] turn_end: state.role=${state.role}`);

    const scores = parseScores(lastMsg);

    // In plan phase, require self-score from dev or review score from qa
    if (
      (state.role === "dev" && scores.devScore === undefined) ||
      (state.role === "qa" && scores.qaScore === undefined)
    ) {
      debugLog(`[agent_end] missing required score: ${state.role}`);
      reinjectTask(pi, state);
      return;
    }

    const scoreSum =
      (state.context.devScore ?? 0) + (state.context.qaScore ?? 0);
    const threshold = state.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

    if (scoreSum >= threshold) {
      if (state.phase === "build" && getSubtaskOrder()) {
        const allSubtasks = getSubtaskOrder()!;
        const currentIdx = state.currentSubtaskIndex ?? 0;

        if (currentIdx + 1 < allSubtasks.length) {
          debugLog(
            `[agent_end] build subtask ${currentIdx} complete, advancing to next`,
          );
          state.context.devScore = 0;
          state.context.qaScore = 0;
          state.nextRole = "dev";
          ctx.ui.setFooter(buildFooter(ctx, () => "dev"));
          advanceSubtask(state);
          writeState(state);
        } else {
          debugLog(
            `[agent_end] all build subtasks complete, advancing to release`,
          );
          const newState = advancePhase(state);
          if (!newState) {
            ctx.ui.notify(
              `✅ [pworkflow] goal completed successfully!!`,
              "info",
            );
            markCompleted(state);
            return;
          }
          delete newState.currentSubtaskIndex;
          delete newState.subtasksCompleted;
          state = newState;
        }
      } else {
        const newState = advancePhase(state);
        if (!newState) {
          ctx.ui.notify(`✅ [pworkflow] goal completed successfully!!`, "info");
          markCompleted(state);
          return;
        }
        state = newState;
      }

      ctx.ui.notify(
        `[pworkflow] threshold met, advancing to next phase: ${state.phase} (${scoreSum} >= ${threshold})`,
        "info",
      );
      debugLog(`[agent_end] 11 switching to dev role`);
      writeState(state);
    } else {
      ctx.ui.notify(
        `[pworkflow] threshold NOT met, continue to revise (${scoreSum} < ${threshold})`,
        "info",
      );
    }

    pi.sendUserMessage("run pworkflow-compact", { deliverAs: "followUp" });
  });

  // ─── Session Shutdown ────────────────────────────────────────────
  pi.on("session_shutdown", (_event, _ctx) => {
    // poller.stop();
  });
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "./workflow";
import { buildDevTask, buildQaTask } from "./tasks";
function reinjectTask(pi: ExtensionAPI, state: any): void {
  const task = state.role === "dev" ? buildDevTask(state) : buildQaTask(state);
  writeTaskFile(state.role, task);
  syncTaskFileMtime(state.role);

  // Add specific failure reason to the reinjected message
  let reason = "";
  if (state.phase === "plan") {
    if (state.role === "dev")
      reason = "No `[DEVSCORE:N]` score detected in your plan";
    else if (state.role === "qa")
      reason = "No `[QA_SCORE:N]` score detected in your review";
  } else {
    const lastMsg = state.context?.lastAgentMessage || "your response";
    reason = `Score threshold not met in ${lastMsg.substring(0, 150)}...`;
  }

  pi.sendUserMessage(
    `⚠️ The previous turn unsuccessfully completed.\n\n${reason}.\n\nHere's your task again:\n\n${task}`,
    { deliverAs: "followUp" },
  );
}

function getSubtaskOrder(): string[] | null {
  const path = join(process.cwd(), ".pworkflow", "task-order.json");
  if (!existsSync(path)) return null;
  try {
    const data = readFileSync(path, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function writeTaskFile(role: string, task: string): void {
  const path = join(process.cwd(), ".pworkflow", `task-${role}.json`);
  const payload = { task, assignedAt: Date.now() };
  try {
    writeFileSync(path, JSON.stringify(payload, null, 2));
  } catch (e) {
    debugLog(`[session] failed to write task file ${path}: ${e}`);
  }
}
