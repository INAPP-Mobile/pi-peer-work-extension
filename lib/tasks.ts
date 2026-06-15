// ─── Task Builders ───────────────────────────────────────────────
//
// Build role prompts from workflow step metadata and artifact contracts.
// Agents exchange durable handoff content through artifact files, not state.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  PW_DIR,
  WorkflowRole,
  WorkflowState,
  WorkflowStep,
  currentStepUsesSubtasks,
  getSubtaskOrder,
  getCurrentStep,
} from "./workflow";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, "..", "prompts");
const SECTIONS_DIR = join(PROMPTS_DIR, "sections");

function load(path: string): string {
  return readFileSync(path, "utf-8").trimEnd() + "\n";
}

const DEV_TASK_TMPL = load(join(PROMPTS_DIR, "dev-task.md"));
const QA_TASK_TMPL = load(join(PROMPTS_DIR, "qa-task.md"));

const DEV_STEP_INSTRUCTIONS = load(join(SECTIONS_DIR, "dev-step.md"));
const QA_STEP_INSTRUCTIONS = load(join(SECTIONS_DIR, "qa-step.md"));

const DEV_TAGS = load(join(SECTIONS_DIR, "dev-tags-default.md"));
const DEV_SCORING = load(join(SECTIONS_DIR, "dev-scoring.md"));
const QA_TAGS = load(join(SECTIONS_DIR, "qa-tags.md"));
const QA_SCORING = load(join(SECTIONS_DIR, "qa-scoring.md"));

function fill(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, val);
  }
  return result;
}

function escapeMarkdownListItem(value: string): string {
  return value.replace(/\n/g, " ");
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("")
    .map((char) => {
      if (char === "*") return "[^/]*";
      if (char === "?") return "[^/]";
      return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");

  return new RegExp(`^${escaped}$`);
}

function listInputArtifacts(step: WorkflowStep): string[] {
  if (step.inputArtifacts.length === 0) {
    return ["No prior artifact required."];
  }

  return step.inputArtifacts.flatMap((artifact) => {
    if (!artifact.includes("*") && !artifact.includes("?")) {
      return [artifact];
    }

    const slashIndex = artifact.lastIndexOf("/");
    const baseDir = slashIndex >= 0 ? artifact.slice(0, slashIndex) : ".";
    const pattern = slashIndex >= 0 ? artifact.slice(slashIndex + 1) : artifact;
    const absoluteDir = join(process.cwd(), baseDir);

    if (!existsSync(absoluteDir)) return [artifact];

    try {
      const regex = globToRegExp(pattern);
      const matches = readdirSync(absoluteDir)
        .filter((name) => regex.test(name))
        .sort()
        .map((name) => join(baseDir, name));

      return matches.length > 0 ? matches : [artifact];
    } catch {
      return [artifact];
    }
  });
}

export function renderArtifactContractSection(
  step: WorkflowStep,
  threshold = DEFAULT_CONFIDENCE_THRESHOLD,
): string {
  const inputs = listInputArtifacts(step).map(escapeMarkdownListItem);
  const outputs = step.outputArtifacts.map(escapeMarkdownListItem);

  return [
    "### Artifact Contract",
    "Read:",
    ...inputs.map((artifact) => `- ${artifact}`),
    "Write:",
    ...outputs.map((artifact) => `- ${artifact}`),
    "Score:",
    `- [${step.scoreTag}:N]`,
    `Combined score threshold: ${threshold}`,
  ].join("\n");
}

function renderSubtaskContextSection(state: WorkflowState, role: WorkflowRole): string {
  if (!currentStepUsesSubtasks(state)) return "";

  const order = getSubtaskOrder();
  if (!order || order.length === 0) {
    return [
      "### Subtask Loop",
      "No subtasks defined yet.",
      role === "dev"
        ? "- Create the subtask specs and `.pworkflow/task-order.json` before continuing."
        : "- Wait for the Dev subtask specs and `.pworkflow/task-order.json` before reviewing.",
    ].join("\n");
  }

  const currentIndex = state.currentSubtaskIndex ?? 0;
  const completed = state.subtasksCompleted ?? [];
  const lines = [
    "### Subtask Loop",
    "Subtasks are in execution order:",
  ];

  for (let i = 0; i < order.length; i++) {
    const subtaskFile = order[i];
    const isCurrent = i === currentIndex;
    const isCompleted = completed.includes(i);
    const status = isCurrent ? "[CURRENT]" : isCompleted ? "[DONE]" : "[PENDING]";
    lines.push(`  ${i + 1}. ${subtaskFile} ${status}`);
  }

  if (currentIndex < order.length) {
    lines.push(`\nCURRENT TASK: doc/${order[currentIndex]}`);
    lines.push(
      role === "dev"
        ? "Read this subtask document and implement only this subtask."
        : "Read this subtask document and review only this subtask.",
    );
  } else {
    lines.push("\nAll subtasks complete. Ready to advance.");
  }

  return lines.join("\n");
}

function renderScoringSection(role: WorkflowRole, threshold: number): string {
  if (role === "dev") {
    return fill(DEV_SCORING, {
      CONFIDENCE_THRESHOLD: String(threshold),
    });
  }

  return fill(QA_SCORING, {
    CONFIDENCE_THRESHOLD: String(threshold),
  });
}

function renderTagSection(role: WorkflowRole): string {
  return role === "dev" ? DEV_TAGS : QA_TAGS;
}

function renderGoalSection(state: WorkflowState): string {
  return state.context?.humanGoal
    ? `\n### Project Goal\n${state.context.humanGoal}\n`
    : "";
}

function buildTaskForRole(state: WorkflowState, role: WorkflowRole): string {
  const step = getCurrentStep(state);
  const instructions = role === "dev" ? DEV_STEP_INSTRUCTIONS : QA_STEP_INSTRUCTIONS;
  const threshold = state.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const template = role === "dev" ? DEV_TASK_TMPL : QA_TASK_TMPL;

  return fill(template, {
    STEP_ID: step.id,
    STEP_NAME: step.name,
    STEP_ROLE: step.role.toUpperCase(),
    STEP_DESCRIPTION: step.description,
    GOAL_SECTION: renderGoalSection(state),
    STEP_INSTRUCTIONS_SECTION: instructions,
    ARTIFACT_CONTRACT_SECTION: renderArtifactContractSection(step, threshold),
    SUBTASK_CONTEXT_SECTION: renderSubtaskContextSection(state, role),
    SCORING_INSTRUCTIONS_SECTION: renderScoringSection(role, threshold),
    TAG_INSTRUCTIONS_SECTION: renderTagSection(role),
  });
}

/** Wrap a dev task with the standard framing message sent to the dev agent. */
export function buildDevMessage(): string {
  if (existsSync(join(PW_DIR(), `task-dev.json`))) {
    return `## You are Dev. Read \`.pworkflow/task-dev.json\``;
  }
  return `## You are Dev - STOP, no file available`;
}

/** Wrap a QA task with the standard framing message sent to the QA agent. */
export function buildQaMessage(): string {
  if (existsSync(join(PW_DIR(), "task-qa.json"))) {
    return `## You are QA. Read \`.pworkflow/task-qa.json\``;
  }
  return `## You are QA - STOP, no file available`;
}

/** Build a dev task prompt from workflow step metadata. */
export function buildDevTask(state: WorkflowState): string {
  return buildTaskForRole(state, "dev");
}

/** Build a QA review task prompt from workflow step metadata. */
export function buildQaTask(state: WorkflowState): string {
  return buildTaskForRole(state, "qa");
}

/** Build a re-verify task when QA's last response missed the required score. */
export function buildReverifyTask(state: WorkflowState): string {
  const task = buildQaTask(state);
  return `## ⚠️ Re-verification Required\n\nNo required score tag was detected in your previous response.\n\nPlease review the artifacts again and include \`[QA_SCORE:N]\` in your response.\n\n${task}`;
}
