// ─── Role Command Handler ────────────────────────────────────────────────
//
// /pworkflow-role command implementation.

import { readState, getRoleModel, setRoleModel } from "./workflow";
import { debugLog } from "./logger";
import { buildFooter } from "./ui";

export async function handleRole(
  args: string,
  ctx: any,
): Promise<void> {
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
    // Model handling is skipped here since we don't have access to pi.setModel
    // Just store the model ID for later use
    setRoleModel(role, modelArg, state);
    ctx.ui.notify(
      `✅ Role '${role}' → model '${modelArg}' stored`,
      "info",
    );
  } else {
    const storedModelId = getRoleModel(role, state);
    if (storedModelId && ctx.model?.id !== storedModelId) {
      ctx.ui.notify(
        `⚠️ Cannot restore model '${storedModelId}' without API context.\nUse /pworkflow-role ${role} <model> to set.`,
        "warning",
      );
    } else {
      ctx.ui.notify(`✅ Role set to '${role}'.`, "info");
    }
  }
}
