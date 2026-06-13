/**
 * Compact handler - prepares session compaction with workflow-aware summary
 *
 * Strategy:
 * 1. Build a minimal 3-line summary containing role, phase, goal, threshold
 * 2. Keep the recent turn messages (via firstKeptEntryId) so task can continue
 * 3. Discard old conversation history by replacing it with summary
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
Phase: ${state.phase}
Goal: ${state.context.humanGoal.substring(0, 200)}`;

    debugLog("[compact] creating workflow summary", summary);

    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
}
