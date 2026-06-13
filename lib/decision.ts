// ─── Workflow Decision Engine ───────────────────────────────────────────
//
// Handles QA's turn_end: reads tags/scores, advances the workflow or
// pushes back to dev / escalates to human.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildDevTask, buildQaTask, buildReverifyTask } from "./tasks";
import {
  writeState,
  failBackToDev,
  markBlocked,
  markCompleted,
  writeTaskFile,
  getCurrentStep,
  WorkflowState,
  WORKFLOW_PHASES,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from "./workflow";
import { notifyTelegram } from "./telegram";
import { debugLog } from "./logger";
import { judgeOutput } from "./qualifier";
import { parseScores, QaTag } from "./tags";
import { unlinkSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Detect QA tag [SUCCESS], [FAILURE], or [BLOCKER] in message. */
export function detectQaTag(message: string): QaTag {
  const upper = message.toUpperCase();
  if (upper.includes("[SUCCESS]")) return "success";
  if (upper.includes("[FAILURE]")) return "failure";
  if (upper.includes("[BLOCKER]")) return "blocker";
  return null;
}

export async function handleQaTurnEnd(
  pi: ExtensionAPI,
  state: WorkflowState,
  qaMessage: string,
): Promise<void> {
  // Qualifier gate: reject non-substantive QA output
  const { verdict: qaVerdict, raw: qaRaw } = await judgeOutput("qa", qaMessage);
  if (qaVerdict === "reject") {
    debugLog("[pworkflow] qualifier REJECTED QA output, re-injecting task");
    // Clean up QA output file so next attempt starts fresh
    const qaOutputPath = join(process.cwd(), ".pworkflow", "output-qa.txt");
    try {
      if (existsSync(qaOutputPath)) unlinkSync(qaOutputPath);
    } catch {}
    writeTaskFile("qa", buildReverifyTask(state));
    pi.sendUserMessage(
      `⚠️ Your review was flagged as not substantive. Qualifier said: "${qaRaw}"\n\nPlease provide detailed analysis, not just a brief approval or placeholder.`,
      { deliverAs: "followUp" },
    );
    return;
  }

  const tag = detectQaTag(qaMessage);

  if (!tag) {
    debugLog("[pworkflow] QA output: no tag detected → reverify");
    writeTaskFile("qa", buildReverifyTask(state));
    return;
  }

  switch (tag) {
    case "success": {
      debugLog("[pworkflow] QA → SUCCESS, checking if can advance");
      break;
    }

    case "failure": {
      debugLog("[pworkflow] QA → FAILURE, pushing back to dev");
      const nextState = failBackToDev(state, qaMessage);
      writeTaskFile("dev", buildDevTask(nextState));
      // Don't notify QA — they already know they flagged issues.
      // Dev's poller will pick up the task file.
      notifyTelegram(
        `🔄 QA flagged FAILURE — dev needs to address feedback\n\nPhase: ${state.phase.toUpperCase()}\nProject: ${process.cwd()}`,
        "Markdown",
      );
      break;
    }

    case "blocker": {
      debugLog(
        "[pworkflow] QA → BLOCKER, sending back to dev with blocker context",
      );
      // Treat as a hard FAILURE — push back to dev, don't deadlock the pipeline
      failBackToDev(state, qaMessage);
      writeTaskFile("dev", buildDevTask(state));
      await notifyTelegram(
        `🚨 QA flagged BLOCKER — dev needs to address and re-submit\n\nPhase: ${state.phase.toUpperCase()}\nProject: ${process.cwd()}`,
        "Markdown",
      );
      pi.sendUserMessage(
        `🚨 Blocking issue flagged! Dev has been notified and will address it.`,
        { deliverAs: "followUp" },
      );
      break;
    }
  }
}
