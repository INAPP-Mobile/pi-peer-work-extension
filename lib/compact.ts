/**
 * Compact handler - prepares session compaction with workflow-aware summary
 *
 * Strategy:
 * 1. Build a minimal workflow continuation summary containing current step, role, and goal
 * 2. Set firstKeptEntryId to the last valid cut point so only summary is kept
 * 3. Agent picks up after compact via task file, not conversation history
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./logger";
import { readState } from "./workflow";

export function initCompact(pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (event, ctx) => {
    const state = readState();

    // If no workflow state or goal, skip compaction preparation
    if (!state || !state.context?.humanGoal) {
      debugLog("[compact] no workflow goal; skipping compact preparation");
      return;
    }

    const summary = `Workflow continuation:
Step: ${state.currentStepId}
Role: ${state.role}
Goal: ${state.context.humanGoal.substring(0, 200)}`;

    // Walk backwards through branch entries to find the last valid cut point
    // (tool results can't be cut points — they must stay with their tool call)
    // This ensures we keep only the most recent turn, not the default ~20k tokens
    const entries = event.branchEntries;
    let lastCutPointId: string | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "message" && entry.message?.role !== "toolResult") {
        lastCutPointId = entry.id;
        break;
      }
    }
    const firstKeptEntryId = lastCutPointId ?? event.preparation.firstKeptEntryId;

    debugLog("[compact] creating workflow summary", summary);
    debugLog("[compact] firstKeptEntryId", firstKeptEntryId);

    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
}
