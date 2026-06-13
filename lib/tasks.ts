// ─── Task Builders ───────────────────────────────────────────────────────
//
// Load prompt templates from prompts/ files and interpolate dynamic values.
// Agents read the other role's output from .pworkflow/ files instead of
// having full content injected into the prompt (saves tokens).

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCurrentStep,
  isPlanPhase,
  isBuildPhase,
  isReleasePhase,
  WorkflowState,
  DEFAULT_CONFIDENCE_THRESHOLD,
  WORKFLOW_PHASES,
  PW_DIR,
  getSubtaskOrder,
  writeTaskFile as wfWriteTaskFile,
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
const DEV_PLAN = load(join(SECTIONS_DIR, "dev-plan.md"));
const DEV_BUILD = load(join(SECTIONS_DIR, "dev-build.md"));
const DEV_RELEASE = load(join(SECTIONS_DIR, "dev-release.md"));
const DEV_TAGS_PLAN = load(join(SECTIONS_DIR, "dev-tags-plan.md"));
const DEV_TAGS_DEFAULT = load(join(SECTIONS_DIR, "dev-tags-default.md"));
const QA_PLAN = load(join(SECTIONS_DIR, "qa-plan.md"));
const QA_BUILD = load(join(SECTIONS_DIR, "qa-build.md"));
const QA_RELEASE = load(join(SECTIONS_DIR, "qa-release.md"));
const QA_SCORING = load(join(SECTIONS_DIR, "qa-scoring.md"));
const QA_TAGS = load(join(SECTIONS_DIR, "qa-tags.md"));

/** Get subtask context for build phase. */
function getBuildSubtaskContext(state: WorkflowState): string {
  const order = getSubtaskOrder();
  if (!order) return "No subtasks defined.";
  
  const currentIndex = state.currentSubtaskIndex ?? 0;
  const completed = state.subtasksCompleted ?? [];
  
  let context = `This is build phase. Subtasks are in execution order:\n\n`;
  for (let i = 0; i < order.length; i++) {
    const subtaskFile = order[i];
    const isCurrent = i === currentIndex;
    const isCompleted = completed.includes(i);
    const status = isCurrent ? "[CURRENT]" : isCompleted ? "[DONE]" : "[PENDING]";
    context += `  ${i + 1}. ${subtaskFile} ${status}\n`;
  }
  
  if (currentIndex < order.length) {
    const current = order[currentIndex];
    context += `\nCURRENT TASK: ${current}\nRead this subtask from doc/${current} and implement it.`;
  } else {
    context += "\nAll subtasks complete. Ready to advance.";
  }
  
  return context.trim();
}

function fill(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, val);
  }
  return result;
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

/** Build a dev task prompt from workflow state, optionally framing the user's original request. */
export function buildDevTask(state: WorkflowState): string {
  const step = getCurrentStep(state);
  const phase = state.phase.toUpperCase();

  const goalSection = state.context?.humanGoal
    ? `\n### Project Goal\n${state.context.humanGoal}\n`
    : "";

  let phaseInstructions: string;
  let tagInstructions: string;

  if (isPlanPhase(state)) {
    phaseInstructions = fill(DEV_PLAN, {
      CONFIDENCE_THRESHOLD: String(
        state.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      ),
    });
    tagInstructions = DEV_TAGS_PLAN;
  } else if (isBuildPhase(state)) {
    const qaFeedback = state.context?.qaFeedback
      ? `
### 🗒️ QA Feedback from Previous Review
${state.context.qaFeedback}
`
      : "";
    phaseInstructions = fill(DEV_BUILD, {
      SUBTASK_CONTEXT: getBuildSubtaskContext(state),
      QA_FEEDBACK: qaFeedback,
    });
    tagInstructions = DEV_TAGS_DEFAULT;
  } else {
    phaseInstructions = DEV_RELEASE;
    tagInstructions = DEV_TAGS_DEFAULT;
  }

  return fill(DEV_TASK_TMPL, {
    PHASE: phase,
    STEP_DESCRIPTION: step.description,
    GOAL_SECTION: goalSection,
    PHASE_INSTRUCTIONS_SECTION: phaseInstructions,
    TAG_INSTRUCTIONS_SECTION: tagInstructions,
  });
}

/** Build a QA review task prompt from workflow state. */
export function buildQaTask(state: WorkflowState): string {
  const step = getCurrentStep(state);
  const phase = state.phase.toUpperCase();

  const goalSection = state.context?.humanGoal
    ? `\n### Project Goal\n${state.context.humanGoal}\n`
    : "";

  let phaseInstructions: string;
  let scoringInstructions: string;
  let tagInstructions: string;

  if (isPlanPhase(state)) {
    phaseInstructions = QA_PLAN;
    scoringInstructions = fill(QA_SCORING, {
      CONFIDENCE_THRESHOLD: String(
        state.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      ),
    });
    tagInstructions = QA_TAGS;
  } else if (isBuildPhase(state)) {
    phaseInstructions = QA_BUILD;
    scoringInstructions = "";
    tagInstructions = QA_TAGS;
  } else {
    phaseInstructions = QA_RELEASE;
    scoringInstructions = "";
    tagInstructions = QA_TAGS;
  }

  return fill(QA_TASK_TMPL, {
    PHASE: phase,
    STEP_DESCRIPTION: step.description,
    GOAL_SECTION: goalSection,
    PHASE_INSTRUCTIONS_SECTION: phaseInstructions,
    SCORING_INSTRUCTIONS_SECTION: scoringInstructions,
    TAG_INSTRUCTIONS_SECTION: tagInstructions,
  });
}

/** Build a re-verify task (no tag was detected in QA's last response). */
export function buildReverifyTask(state: WorkflowState): string {
  const task = buildQaTask(state);
  return `## ⚠️ Re-verification Required\n\nNo status tag ([SUCCESS], [FAILURE], or [BLOCKER]) was detected in your previous response.\n\nPlease review the artifacts again and include ONE of the required tags in your response.\n\n${task}`;
}
