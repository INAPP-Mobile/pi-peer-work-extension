/**
 * Peer Workflow Extension — async build/release pipeline between dev and qa.
 *
 * Two-phase workflow:
 *   BUILD  → dev builds → qa reviews  → [SUCCESS]→RELEASE  [FAILURE]→dev  [BLOCKER]→Telegram
 *   RELEASE → dev deploys+publishes → qa confirms → [SUCCESS]→done+Telegram  [FAILURE]→dev  [BLOCKER]→Telegram
 *
 * Each agent starts a fresh session. On turn_end, the extension reads the
 * assistant's message, applies decision logic, and writes the next task file
 * for the next agent session.
 *
 * Decision tags (in QA output):
 *   [SUCCESS] → advance to next step
 *   [FAILURE] → push back to dev with QA's message
 *   [BLOCKER] → escalate to human via Telegram
 *   no tag   → reverify (rerun QA)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  readState,
  initState,
  resetState,
  getCurrentStep,
  isBuildPhase,
  isReleasePhase,
  advanceStep,
  failBackToDev,
  markBlocked,
  markCompleted,
  writeTaskFile,
  clearTaskFile,
  WorkflowState,
  WORKFLOW_STEPS,
  Role,
  isPlanPhase,
} from "./lib/workflow";
import { notifyTelegram } from "./lib/telegram";
import { debugLog, setupDebugLogging } from "./lib/logger";

// ─── Role Detection ─────────────────────────────────────────────────────

function detectRole(): Role | null {
  // 1. Env var override
  const envRole = process.env.PWORKFLOW_ROLE || process.env.WORKFLOW_ROLE;
  if (envRole === "dev" || envRole === "qa") return envRole;
  return null;
}

function getRoleTag(MY_ROLE: string | undefined, theme: any): string | undefined {
  const roles = ["dev", "qa"];
  return roles
    .filter((r) => {
      if (r.toUpperCase() === MY_ROLE!.toUpperCase()) {
        debugLog(`[pworkflow] getRoleTag filter: matched role ${r}`);
        return r;
      } else {
        debugLog(`[pworkflow] getRoleTag filter: no match for ${r}, MY_ROLE=${MY_ROLE}`);
        return undefined;
      }
    })
    .map((r) => {
      // inactive role shows as disabled (dim), active role is highlighted
      const fgColor = MY_ROLE === r ? "success" : "dim";
      debugLog(`[pworkflow] getRoleTag: r=${r}, MY_ROLE=${MY_ROLE}, fgColor=${fgColor}`);
      return theme.bg("selectedBg", theme.fg(fgColor as any, ` ${r.toUpperCase()} `));
    })
    .toString();
}

// ─── Utility: Read file helper ──────────────────────────────────────────

function readFileSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// Track last read mtime for output file to detect new writes
const fileMtimes = new Map<string, number>();

// ─── Utility: Extract last assistant message ────────────────────────────

function extractLastMessage(event: any): string {
  let lastMsg = "";
  const content = event?.message?.content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b: any) => b?.type === "text");
    lastMsg = textBlock?.text || "";
  } else if (typeof content === "string") {
    lastMsg = content;
  } else if (content) {
    lastMsg = String(content);
  }
  return lastMsg;
}

// ─── Utility: Detect tag in message ─────────────────────────────────────

type QaTag = "success" | "failure" | "blocker" | null;

function detectQaTag(text: string): QaTag {
  const upper = text.toUpperCase();
  if (upper.includes("[SUCCESS]")) return "success";
  if (upper.includes("[FAILURE]")) return "failure";
  if (upper.includes("[BLOCKER]")) return "blocker";
  return null;
}

// ─── Utility: Build dev task from workflow state ────────────────────────

function buildDevTask(state: WorkflowState, feedbackFromQa?: string): string {
  const step = getCurrentStep(state);
  const phase = state.phase.toUpperCase();

  let task = `## ${phase} Phase — Dev Task\n\n`;
  task += `Step: ${step.description}\n\n`;

  if (isPlanPhase(state)) {
    task += `### Plan Instructions\n`;
    task += `1. Run build commands for the project\n`;
    task += `2. Ensure unit tests pass\n`;
    task += `3. Verify lint is clean\n`;
    task += `4. Package/build artifacts for review\n`;
  } else if (isBuildPhase(state)) {
    task += `### Build Instructions\n`;
    task += `1. Run build commands for the project\n`;
    task += `2. Ensure unit tests pass\n`;
    task += `3. Verify lint is clean\n`;
    task += `4. Package/build artifacts for review\n`;
  } else if (isReleasePhase(state)) {
    task += `### Deploy & Publish Instructions\n`;
    task += `1. Deploy to target environment\n`;
    task += `2. Publish artifacts/packages\n`;
    task += `3. Verify deployment is live\n`;
  }

  if (feedbackFromQa) {
    task += `\n### Previous QA Feedback (address these)\n${feedbackFromQa}\n`;
  }

  task += `\n### Tag your final message\n`;
  task += `When done, include \`[SUCCESS]\` or \`[FAILURE]\` or \`[BLOCKER]\` in your response.\n`;

  return task;
}

// ─── Utility: Build QA task from workflow state ─────────────────────────

function buildQaTask(state: WorkflowState, devOutput?: string): string {
  const step = getCurrentStep(state);
  const phase = state.phase.toUpperCase();

  let task = `## ${phase} Phase — QA Task\n\n`;
  task += `Step: ${step.description}\n\n`;

  if (isBuildPhase(state)) {
    task += `### Review Build\n`;
    task += `Review the build output below and check:\n`;
    task += `- Build completed successfully?\n`;
    task += `- Tests pass?\n`;
    task += `- Any warnings or errors?\n`;
  } else if (isReleasePhase(state)) {
    task += `### Confirm Release\n`;
    task += `Verify the deployment/publish:\n`;
    task += `- Deployment is live?\n`;
    task += `- Artifacts are published?\n`;
    task += `- Smokes pass?\n`;
  }

  if (devOutput) {
    task += `\n### Dev Output (for review)\n${devOutput}\n`;
  }

  task += `\n### CRITICAL — Include ONE of these tags in your response:\n`;
  task += `- \`[SUCCESS]\` — Everything looks good, proceed to next step\n`;
  task += `- \`[FAILURE]\` — Something is wrong, push back to dev with details\n`;
  task += `- \`[BLOCKER]\` — Cannot proceed, needs human intervention\n`;
  task += `\nIf no tag is detected, you will be asked to reverify.\n`;

  return task;
}

// ─── Utility: Build reverify task (no tag detected) ─────────────────────

function buildReverifyTask(state: WorkflowState): string {
  const task = buildQaTask(state);
  return `## ⚠️ Re-verification Required\n\nNo status tag ([SUCCESS], [FAILURE], or [BLOCKER]) was detected in your previous response.\n\nPlease review the artifacts again and include ONE of the required tags in your response.\n\n${task}`;
}

// ─── Workflow Decision Engine ───────────────────────────────────────────

async function handleQaTurnEnd(
  pi: ExtensionAPI,
  state: WorkflowState,
  qaMessage: string,
): Promise<void> {
  const tag = detectQaTag(qaMessage);

  if (!tag) {
    // No tag → reverify. Write task for QA again.
    debugLog("[pworkflow] QA output: no tag detected → reverify");
    writeTaskFile("qa", buildReverifyTask(state));
    return;
  }

  switch (tag) {
    case "success": {
      debugLog("[pworkflow] QA → SUCCESS, advancing step");
      const isLastStep =
        state.stepIndex >= WORKFLOW_STEPS.length - 1 ||
        WORKFLOW_STEPS[state.stepIndex + 1] === undefined;

      if (isLastStep) {
        // Workflow complete (release confirmed)
        markCompleted(state);
        const msg = `✅ Peer Workflow Complete\n\nProject: ${process.cwd()}\nRelease completed successfully after QA confirmation.\n\nPhase: RELEASE\nStatus: COMPLETED`;
        await notifyTelegram(msg, "Markdown");
        pi.sendUserMessage(
          `🏁 Workflow complete! Release confirmed by QA. Human has been notified via Telegram.`,
          { deliverAs: "followUp" },
        );
      } else {
        // Advance to next step
        const nextState = advanceStep(state);
        const nextRole = nextState.role;
        const task =
          nextRole === "dev" ? buildDevTask(nextState) : buildQaTask(nextState);
        writeTaskFile(nextRole, task);
        pi.sendUserMessage(
          `✅ QA approved! Moving to next step: ${getCurrentStep(nextState).description} (${nextRole}).`,
          { deliverAs: "followUp" },
        );
      }
      break;
    }

    case "failure": {
      debugLog("[pworkflow] QA → FAILURE, pushing back to dev");
      const nextState = failBackToDev(state, qaMessage);
      writeTaskFile("dev", buildDevTask(nextState, qaMessage));
      pi.sendUserMessage(
        `⚠️ QA flagged issues. Pushed back to dev with feedback.`,
        { deliverAs: "followUp" },
      );
      break;
    }

    case "blocker": {
      debugLog("[pworkflow] QA → BLOCKER, escalating to human");
      markBlocked(state, qaMessage);
      const msg = `🚨 Workflow Blocked — Human Intervention Required\n\nProject: ${process.cwd()}\nPhase: ${state.phase.toUpperCase()}\n\n**QA Report:**\n${qaMessage.slice(0, 1000)}`;
      await notifyTelegram(msg, "Markdown");
      pi.sendUserMessage(
        `🚨 Blocked! Escalated to human via Telegram. Waiting for intervention.`,
        { deliverAs: "followUp" },
      );
      break;
    }
  }
}

// ─── Extension Entry ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let MY_ROLE: Role | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let isWaitingForRole = false;

  // ─── Commands ───────────────────────────────────────────────────────

  // /pworkflow-init — initialise the workflow pipeline
  pi.registerCommand("pworkflow-init", {
    description:
      "Initialise a new peer workflow pipeline. Resets any existing state. " +
      "Usage: /pworkflow-init",
    handler: async (_args: unknown, ctx) => {
      const state = initState();

      // Merge .gitignore-template into project root .gitignore if available
      try {
        const templatePath = join(process.cwd(), ".gitignore-template");
        const gitignorePath = join(process.cwd(), ".gitignore");

        if (existsSync(templatePath)) {
          let existing = "";
          if (existsSync(gitignorePath)) {
            existing = readFileSync(gitignorePath, "utf-8");
          }

          const templateContents = readFileSync(templatePath, "utf-8").trim();
          const hasTemplateContent =
            existing.includes(".pworkflow/") ||
            templateContents
              .split("\n")
              .filter((l) => l.trim() && !l.trim().startsWith("#"))
              .some((line) => existing.includes(line));

          if (!hasTemplateContent) {
            const merged = `${templateContents}\n\n${existing}`;
            writeFileSync(gitignorePath, merged, "utf-8");
            ctx.ui.notify(
              `✅ Peer workflow initialised.\n` +
                `Phase: BUILD\n` +
                `Step: dev builds\n` +
                `.gitignore created/merged from .gitignore-template`,
              "info",
            );
          }
        }
      } catch {}

      ctx.ui.notify(
        `✅ Peer workflow initialised.\n` +
          `Phase: BUILD\n` +
          `Step: dev builds\n` +
          `Set roles: PWORKFLOW_ROLE=dev or PWORKFLOW_ROLE=qa in each terminal.`,
        "info",
      );
    },
  });

  // /pworkflow-status — show current workflow state
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
          `Step Index: ${state.stepIndex}/${WORKFLOW_STEPS.length - 1}\n` +
          `Started: ${new Date(state.startedAt).toISOString()}`,
        "info",
      );
    },
  });

  // /pworkflow-reset — reset workflow state
  pi.registerCommand("pworkflow-reset", {
    description: "Reset the peer workflow completely. Usage: /pworkflow-reset",
    handler: async (_args: unknown, ctx) => {
      resetState();
      ctx.ui.notify(
        "✅ Workflow state reset. Run /pworkflow-init to start fresh.",
        "info",
      );
    },
  });

  // /pworkflow-role — set role for this terminal
  pi.registerCommand("pworkflow-role", {
    description: "Set your role: dev or qa. Usage: /pworkflow-role [dev|qa]",
    handler: async (args: string, ctx) => {
      const role = args.trim().toLowerCase();
      if (role !== "dev" && role !== "qa") {
        ctx.ui.notify("Usage: /pworkflow-role dev|qa", "error");
        return;
      }
      MY_ROLE = role;
      ctx.ui.notify(`✅ Role set to '${role}'. Reloading...`, "info");
      await ctx.reload();
    },
  });

  // ─── Agent-facing tool: send Telegram notification ─────────────
  pi.registerTool({
    name: "pworkflow-notify",
    label: "Telegram Notification",
    description:
      "Send a notification to the human via Telegram. Uses settings from .pworkflow/settings.json.",
    parameters: Type.Object({
      message: Type.String({ description: "The notification message content" }),
    }),
    async execute(_toolCallId, params) {
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
      };
    },
  });

  // ─── Polling: Wait for task/output file ────────────────────────────

  function startPollingForHandoff(waitingRole: Role): void {
    if (pollTimer) clearInterval(pollTimer);
    isWaitingForRole = true;

    pollTimer = setInterval(() => {
      const state = readState();
      if (!state) return;

      // Check if the expected role has changed to ours
      if (state.role !== waitingRole) return;

      const outputPath = join(process.cwd(), ".pworkflow", "output-qa.txt");

      if (waitingRole === "qa" && existsSync(outputPath)) {
        try {
          const mtime = statSync(outputPath).mtimeMs;
          const key = "output-qa.txt";
          const lastRead = fileMtimes.get(key) || 0;

          if (mtime > lastRead) {
            fileMtimes.set(key, mtime);
            const devOutput = readFileSync(outputPath, "utf-8");
            const task = buildQaTask(state, devOutput);
            writeTaskFile("qa", task);
            pi.sendUserMessage(
              `## 🔍 QA Task — Your Turn\n\n${task}\n\nReview the output above. Tag your final response with [SUCCESS], [FAILURE], or [BLOCKER] and confidence level [0-100].`,
              { deliverAs: "followUp" },
            );
            debugLog(
              "[pworkflow] polling: injected QA task after detecting dev output",
            );
            if (pollTimer) {
              clearInterval(pollTimer);
              pollTimer = null;
            }
            isWaitingForRole = false;
          }
        } catch {}
      }

      if (waitingRole === "dev") {
        const taskPath = join(process.cwd(), ".pworkflow", "task-dev.json");
        if (existsSync(taskPath)) {
          try {
            const mtime = statSync(taskPath).mtimeMs;
            const key = "task-dev.json";
            const lastRead = fileMtimes.get(key) || 0;
            if (mtime > lastRead) {
              fileMtimes.set(key, mtime);
              const feedback = state.context.qaFeedback;
              const task = buildDevTask(state, feedback);
              pi.sendUserMessage(
                `## 🛠 Dev Task — Your Turn\n\n${task}\n\nWork on this now. Tag your final response with [SUCCESS], [FAILURE], or [BLOCKER] and confidence level [0-100].`,
                { deliverAs: "followUp" },
              );
              debugLog(
                "[pworkflow] polling: injected dev task after detecting task file",
              );
              if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
              }
              isWaitingForRole = false;
            }
          } catch {}
        }
      }
    }, 3000);
  }

  // ─── Session Start ──────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    MY_ROLE = detectRole();
    debugLog(`[pworkflow] session_start: MY_ROLE=${MY_ROLE}`);

    if (!MY_ROLE) {
      return; // No workflow role configured — skip
    }

    setupDebugLogging();

    // Sync cwd
    try {
      process.chdir(ctx.cwd);
    } catch {}

    // ── Show role on the bottom bar ──
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          debugLog(`[pworkflow] footer render: MY_ROLE=${MY_ROLE}`);
          const branch = footerData.getGitBranch();
          let input = 0, output = 0, cost = 0;
          for (const e of ctx.sessionManager.getEntries()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as any;
              input += m.usage?.input || 0;
              output += m.usage?.output || 0;
              cost += m.usage?.cost?.total || 0;
            }
          }
          const fmt = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
          const contextUsage = ctx.getContextUsage();
          const cw = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const cp = contextUsage?.percent;
          const ctxStr = cp != null ? `${cp.toFixed(1)}%/${fmt(cw)}` : `?/${fmt(cw)}`;
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
          const roleTag = getRoleTag(MY_ROLE, theme);
          const lines = [
            truncateToWidth(
              theme.fg("dim", pwdLine),
              width,
              theme.fg("dim", "..."),
            ),
            truncateToWidth(left + pad + right, width),
          ];
          // Add role tag on a third line
          if (roleTag) {
            lines.push(truncateToWidth(roleTag, width));
          }
          return lines;
        },
      };
    });

    // Read or init workflow state
    let state = readState();
    if (!state) {
      // Auto-init if it doesn't exist (idempotent)
      state = initState();
    }

    // Determine what to do based on role vs expected role
    const expectedRole = state.role;

    if (MY_ROLE !== expectedRole) {
      // Not this agent's turn. Start polling for handoff.
      const currentStep = getCurrentStep(state);
      pi.sendUserMessage(
        `⏳ Not your turn yet. The workflow expects ${expectedRole} (step: ${currentStep.description}).\n` +
          `Your role: ${MY_ROLE}. I'll notify you when it's your turn.\n\n` +
          `Use /pworkflow-status to check progress.`,
        { deliverAs: "followUp" },
      );
      // Poll for when it becomes our turn
      startPollingForHandoff(MY_ROLE);
      return;
    }

    // It IS this agent's turn → inject the task
    if (MY_ROLE === "dev") {
      const feedback = state.context.qaFeedback;
      const task = buildDevTask(state, feedback);
      writeTaskFile("dev", task);
      pi.sendUserMessage(
        `## 🛠 Dev Task — Your Turn\n\n${task}\n\nWork on this now. Tag your final response with [SUCCESS], [FAILURE], or [BLOCKER].`,
        { deliverAs: "followUp" },
      );
    } else if (MY_ROLE === "qa") {
      // Read dev output (stored from previous session's turn_end)
      const devOutputPath = join(process.cwd(), ".pworkflow", "output-qa.txt");
      const devOutput = readFileSafe(devOutputPath);

      if (!devOutput && state.status === "in_progress") {
        // Dev output doesn't exist yet — start polling
        pi.sendUserMessage(
          `⏳ Waiting for dev to finish their work. I'll notify you when it's ready.`,
          { deliverAs: "followUp" },
        );
        startPollingForHandoff("qa");
        return;
      }

      const task = buildQaTask(state, devOutput || undefined);
      writeTaskFile("qa", task);
      pi.sendUserMessage(
        `## 🔍 QA Task — Your Turn\n\n${task}\n\nReview the output above. Tag your final response with [SUCCESS], [FAILURE], or [BLOCKER].`,
        { deliverAs: "followUp" },
      );
    }
  });

  // ─── Turn End ───────────────────────────────────────────────────────
  pi.on("turn_end", async (event, _ctx) => {
    if (!MY_ROLE) return;

    const lastMsg = extractLastMessage(event);
    if (!lastMsg) return;

    const state = readState();
    if (!state) return;

    debugLog(
      `[pworkflow] turn_end: role=${MY_ROLE}, state.role=${state.role}`,
    );

    // Only act if this role matches the expected workflow role
    if (MY_ROLE !== state.role) return;

    if (MY_ROLE === "dev") {
      // Dev finished. Write their output for QA to read later.
      // Dev outputs to output-qa.txt (the file QA reads)
      const outputPath = join(process.cwd(), ".pworkflow", "output-qa.txt");
      const dir = join(process.cwd(), ".pworkflow");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(outputPath, lastMsg, "utf-8");
      debugLog("[pworkflow] dev output written to output-qa.txt");

      // Clear dev task
      clearTaskFile("dev");

      // Transition to QA step
      const isLastStep =
        state.stepIndex >= WORKFLOW_STEPS.length - 1 ||
        WORKFLOW_STEPS[state.stepIndex + 1] === undefined;

      if (isLastStep) {
        // Edge case: dev at last step should not happen, but handle gracefully
        markCompleted(state);
        await notifyTelegram(
          `✅ Peer Workflow Complete (dev finished last step)\n\nProject: ${process.cwd()}`,
          "Markdown",
        );
        return;
      }

      const nextState = advanceStep(state);
      const qaTask = buildQaTask(nextState, lastMsg);
      writeTaskFile("qa", qaTask);
      debugLog("[pworkflow] advanced to QA step, task written");
    } else if (MY_ROLE === "qa") {
      // QA finished — run the decision engine
      debugLog("[pworkflow] QA turn_end, running decision engine");
      await handleQaTurnEnd(pi, state, lastMsg);

      // Clear QA task
      clearTaskFile("qa");
    }
  });

  // ─── Session Shutdown ───────────────────────────────────────────────
  pi.on("session_shutdown", (_event, _ctx) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    isWaitingForRole = false;
    fileMtimes.clear();
    MY_ROLE = null;
  });
}
