// ─── UI / Role Utilities ─────────────────────────────────────────────────
//
// Role detection from env vars, footer builder, and common message helpers.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { WorkflowRole } from "./workflow";

/** Detect role from PWORKFLOW_ROLE or WORKFLOW_ROLE env vars. */
export function detectRole(): WorkflowRole | null {
  const envRole = process.env.PWORKFLOW_ROLE;
  if (envRole === "dev" || envRole === "qa") return envRole;
  return null;
}

/** Build a styled role badge tag for the footer. */
export function getRoleTag(
  MY_ROLE: string | undefined,
  theme: any,
): string | undefined {
  if (!MY_ROLE) return undefined;
  const fgColor = MY_ROLE === "dev" ? "success" : "dim";
  return theme.bg(
    "selectedBg",
    theme.fg(fgColor, ` ${MY_ROLE.toUpperCase()} `),
  );
}

/** Safe file read — returns null if missing or unreadable. */
export function readFileSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Extract the last assistant message text from agent_end event.messages */
export function extractLastAgentMessage(event: any): string | null {
  const messages = event?.messages ?? [];
  // Find the last assistant message with text content
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const content = m.content;
    if (Array.isArray(content)) {
      const textBlock = content.find((b: any) => b?.type === "text");
      if (textBlock?.text) return textBlock.text;
    } else if (typeof content === "string" && content.trim()) {
      return content;
    }
  }
  return null;
}

/** Extract assistant message text from a single AgentMessage (e.g., message_end event) */
export function extractLastAgentMessageFromMessage(message: any): string | null {
  if (!message || message.role !== "assistant") return null;
  const content = message.content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b: any) => b?.type === "text");
    if (textBlock?.text) return textBlock.text.trim();
  } else if (typeof content === "string" && content.trim()) {
    return content;
  }
  return null;
}

/** Build the custom footer showing stats, branch, and role badge. */
export function buildFooter(
  ctx: {
    sessionManager: any;
    getContextUsage: () => any;
    model?: any;
    cwd: string;
  },
  getRole: () => WorkflowRole | null,
) {
  return (tui: any, theme: any, footerData: any) => {
    const unsub = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsub,
      invalidate() {},
      render(width: number): string[] {
        const MY_ROLE = getRole();
        const branch = footerData.getGitBranch();
        let input = 0,
          output = 0,
          cost = 0;
        for (const e of ctx.sessionManager.getEntries()) {
          if (e.type === "message" && e.message.role === "assistant") {
            const m = e.message as any;
            input += m.usage?.input || 0;
            output += m.usage?.output || 0;
            cost += m.usage?.cost?.total || 0;
          }
        }
        const fmt = (n: number) =>
          n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
        const contextUsage = ctx.getContextUsage();
        const cw = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const cp = contextUsage?.percent;
        const ctxStr =
          cp != null ? `${cp.toFixed(1)}%/${fmt(cw)}` : `?/${fmt(cw)}`;
        const ctxDisplay =
          cp != null && cp > 90
            ? theme.fg("error", ctxStr)
            : cp != null && cp > 70
              ? theme.fg("warning", ctxStr)
              : ctxStr;
        const stats = theme.fg(
          "dim",
          ` ↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)} ${ctxDisplay}`,
        );
        const left = stats;
        const right = theme.fg("dim", `${ctx.model?.id || ""}`);
        const padLen = Math.max(
          1,
          width - visibleWidth(left) - visibleWidth(right),
        );
        const pad = " ".repeat(padLen);
        const pwd = ctx.cwd;
        const pwdLine = branch ? `${pwd} (${branch})` : pwd;
        const badge =
          MY_ROLE === "dev" ? "DEV" : MY_ROLE === "qa" ? "QA" : undefined;
        return [
          truncateToWidth(
            theme.fg("dim", pwdLine),
            width,
            theme.fg("dim", "..."),
          ),
          truncateToWidth(left + pad + right, width),
          badge && truncateToWidth(badge, width),
        ].filter(Boolean) as string[];
      },
    };
  };
}
