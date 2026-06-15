// ─── Workflow State Machine ─────────────────────────────────────────────
//
// Step-driven pipeline between dev and qa roles.
// The step graph is the source of truth for routing, scores, and artifacts.

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { debugLog } from "./logger";

export type WorkflowPhase = "plan" | "divide" | "build" | "release";
export type WorkflowRole = "dev" | "qa";
export type WorkflowStatus = "in_progress" | "completed" | "blocked" | "failed";
export type StepId = string;
export type ScoreTag = "DEVSCORE" | "QA_SCORE";
export type StatusTag = "SUCCESS" | "FAILURE" | "BLOCKER";

export type StepTarget =
  | StepId
  | "complete"
  | "next-step"
  | "retry-current-role"
  | "next-role"
  | "human";

export interface WorkflowStep {
  id: StepId;
  phase: WorkflowPhase;
  name: string;
  role: WorkflowRole;
  description: string;
  inputArtifacts: string[];
  outputArtifacts: string[];
  scoreTag: ScoreTag;
  requiredScoreOwner: WorkflowRole;
  onSuccess: StepTarget;
  onLowScore: StepTarget;
  onBlocker?: "human";
  subtaskLoop?: boolean;
}

export interface WorkflowState {
  phase: WorkflowPhase;
  currentStepId: StepId;
  role: WorkflowRole;
  nextRole: WorkflowRole;
  stepIndex: number;
  startedAt: number;
  updatedAt: number;
  status: WorkflowStatus;
  devTaskFile: string;
  qaTaskFile: string;
  confidenceThreshold: number;
  currentSubtaskIndex?: number;
  subtasksCompleted?: number[];
  roleModels?: {
    dev?: string;
    qa?: string;
  };
  context: {
    humanGoal?: string;
    devScore?: number;
    qaScore?: number;
    notes?: string;
    lastAgentMessage?: string;
  };
}

export interface ParsedAgentOutcome {
  devScore?: number;
  qaScore?: number;
  invalidScores?: ("devScore" | "qaScore")[];
  statusTag?: StatusTag;
  rawMessage?: string;
}

export type WorkflowTransition =
  | {
      type: "advance";
      step: WorkflowStep;
      targetStepId: StepId;
      nextRole: WorkflowRole;
      message: string;
    }
  | {
      type: "advance-subtask";
      step: WorkflowStep;
      targetStepId: StepId;
      nextRole: WorkflowRole;
      message: string;
    }
  | {
      type: "route";
      step: WorkflowStep;
      targetStepId: StepId;
      nextRole: WorkflowRole;
      message: string;
    }
  | {
      type: "reinject-current-step";
      step: WorkflowStep;
      reason: string;
    }
  | {
      type: "blocked";
      step: WorkflowStep;
      message: string;
    }
  | {
      type: "complete";
      step: WorkflowStep;
      message: string;
    };

/** Default combined score threshold (devScore + qaScore), max 200. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 180;

// ─── Workflow Step Definitions ──────────────────────────────────────────

export const WORKFLOW_STEPS: WorkflowStep[] = [
  {
    id: "plan.dev",
    phase: "plan",
    name: "Plan Dev",
    role: "dev",
    description:
      "Plan step: dev researches a plan for the human goal, then QA validates it.\n" +
      "- Dev produces a plan outline with clear steps to achieve the human's goal.\n" +
      "- If plan exceeds 8k tokens, split into parts (plan-part1.md, plan-part2.md...).\n" +
      "- For multi-part plans: dev writes summary.md combining key points and per-part scores (0-100 each).\n" +
      "- QA reviews the summary (and all parts if needed within token budget), finds missing parts or ambiguities.\n" +
      "- QA scores confidence in the overall plan on scale 0-100.",
    inputArtifacts: [],
    outputArtifacts: ["plan.md"],
    scoreTag: "DEVSCORE",
    requiredScoreOwner: "dev",
    onSuccess: "plan.qa",
    onLowScore: "retry-current-role",
  },
  {
    id: "plan.qa",
    phase: "plan",
    name: "Plan QA",
    role: "qa",
    description:
      "Plan QA step: QA reviews the plan artifact and scores readiness.",
    inputArtifacts: ["plan.md"],
    outputArtifacts: ["qa-review.md"],
    scoreTag: "QA_SCORE",
    requiredScoreOwner: "qa",
    onSuccess: "divide.dev",
    onLowScore: "plan.dev",
  },
  {
    id: "divide.dev",
    phase: "divide",
    name: "Divide Dev",
    role: "dev",
    description:
      "Divide step: dev breaks the approved plan into executable subtasks, then QA validates scope.\n" +
      "- Dev breaks the plan into smaller actionable tasks, each under 8k token budget.\n" +
      "- Dev writes each task in a separate document in the doc folder with numbered filenames (task-001.md, task-002.md...).\n" +
      "- Dev records execution order in .pworkflow/task-order.json (ordered list of filenames).\n" +
      "- QA verifies tasks are written in executable order and matches the recorded order.\n" +
      "- Dev scores completeness of the subtask division on scale 0-100.\n" +
      "- QA checks for gaps, dependencies, feasibility, and token budget compliance.\n" +
      "- QA scores confidence in the division plan on scale 0-100.",
    inputArtifacts: ["plan.md"],
    outputArtifacts: ["doc/task-*.md", ".pworkflow/task-order.json"],
    scoreTag: "DEVSCORE",
    requiredScoreOwner: "dev",
    onSuccess: "divide.qa",
    onLowScore: "retry-current-role",
  },
  {
    id: "divide.qa",
    phase: "divide",
    name: "Divide QA",
    role: "qa",
    description:
      "Divide QA step: QA reviews the task split and execution order.",
    inputArtifacts: ["doc/task-*.md", ".pworkflow/task-order.json"],
    outputArtifacts: ["qa-review.md"],
    scoreTag: "QA_SCORE",
    requiredScoreOwner: "qa",
    onSuccess: "build.dev",
    onLowScore: "divide.dev",
  },
  {
    id: "build.dev",
    phase: "build",
    name: "Build Dev",
    role: "dev",
    description:
      "Build subtask step: dev implements one subtask, then QA reviews it.",
    inputArtifacts: ["doc/task-*.md", ".pworkflow/task-order.json"],
    outputArtifacts: ["build-output.md"],
    scoreTag: "DEVSCORE",
    requiredScoreOwner: "dev",
    onSuccess: "build.qa",
    onLowScore: "retry-current-role",
    subtaskLoop: true,
  },
  {
    id: "build.qa",
    phase: "build",
    name: "Build QA",
    role: "qa",
    description:
      "Build QA step: QA reviews the implementation artifact and scores readiness.",
    inputArtifacts: ["build-output.md", "doc/task-*.md", ".pworkflow/task-order.json"],
    outputArtifacts: ["qa-review.md"],
    scoreTag: "QA_SCORE",
    requiredScoreOwner: "qa",
    onSuccess: "next-step",
    onLowScore: "build.dev",
    subtaskLoop: true,
  },
  {
    id: "release.dev",
    phase: "release",
    name: "Release Dev",
    role: "dev",
    description:
      "Release step: dev deploys/publishes the completed work, then QA confirms readiness.",
    inputArtifacts: ["build-output.md"],
    outputArtifacts: ["release-output.md"],
    scoreTag: "DEVSCORE",
    requiredScoreOwner: "dev",
    onSuccess: "release.qa",
    onLowScore: "retry-current-role",
  },
  {
    id: "release.qa",
    phase: "release",
    name: "Release QA",
    role: "qa",
    description:
      "Release QA step: QA confirms deployment, artifacts, and smoke checks.",
    inputArtifacts: ["release-output.md"],
    outputArtifacts: ["qa-review.md"],
    scoreTag: "QA_SCORE",
    requiredScoreOwner: "qa",
    onSuccess: "complete",
    onLowScore: "release.dev",
  },
];

export const GITIGNORE_CONTENT = [
  `# Auto-generated by pworkflow
.pworkflow/*
.pworkflow/task-*.json
`,
].join("\n");

// ─── State ──────────────────────────────────────────────────────────────

const STATE_FILE = "state.json";

function otherRole(role: WorkflowRole): WorkflowRole {
  return role === "dev" ? "qa" : "dev";
}

function legacyStateCandidates(): string[] {
  const nestedDir = join(PW_DIR(), ".pworkflow");
  const candidates = [join(nestedDir, STATE_FILE)];

  if (!existsSync(nestedDir)) return candidates;

  try {
    for (const name of readdirSync(nestedDir)) {
      if (/^state.*\.json$/.test(name)) {
        candidates.push(join(nestedDir, name));
      }
    }
  } catch {}

  return candidates;
}

function findStepIndex(state: Partial<WorkflowState>): number {
  if (state.currentStepId) {
    const byId = WORKFLOW_STEPS.findIndex((step) => step.id === state.currentStepId);
    if (byId >= 0) return byId;
  }

  const byIndex = Number.isInteger(state.stepIndex) ? state.stepIndex! : 0;
  return Math.max(0, Math.min(byIndex, WORKFLOW_STEPS.length - 1));
}

function getStepAt(state: Partial<WorkflowState>): WorkflowStep {
  return WORKFLOW_STEPS[findStepIndex(state)] ?? WORKFLOW_STEPS[0];
}

function normalizeState(raw: Partial<WorkflowState>): WorkflowState {
  const idx = findStepIndex(raw);
  const step = WORKFLOW_STEPS[idx] ?? WORKFLOW_STEPS[0];
  const context = { ...(raw.context ?? {}) } as WorkflowState["context"];

  // Remove legacy content-heavy fields. Artifacts own handoff content.
  delete (context as any).buildResult;
  delete (context as any).deployResult;
  delete (context as any).publishResult;
  delete (context as any).qaFeedback;

  const state: WorkflowState = {
    phase: step.phase,
    currentStepId: step.id,
    role: raw.role ?? step.role,
    nextRole: raw.nextRole ?? otherRole(raw.role ?? step.role),
    stepIndex: idx,
    startedAt: raw.startedAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
    status: raw.status ?? "in_progress",
    devTaskFile: raw.devTaskFile ?? join(PW_DIR(), "task-dev.json"),
    qaTaskFile: raw.qaTaskFile ?? join(PW_DIR(), "task-qa.json"),
    confidenceThreshold:
      raw.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
    currentSubtaskIndex: raw.currentSubtaskIndex,
    subtasksCompleted: raw.subtasksCompleted,
    roleModels: raw.roleModels,
    context,
  };

  return state;
}

function migrateLegacyState(): WorkflowState | null {
  for (const path of legacyStateCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const data = readFileSync(path, "utf-8");
      const state = normalizeState(JSON.parse(data));
      writeState(state);
      try {
        unlinkSync(path);
      } catch {}
      return state;
    } catch {}
  }
  return null;
}

export function readState(): WorkflowState | null {
  const path = join(PW_DIR(), STATE_FILE);
  if (!existsSync(path)) {
    return migrateLegacyState();
  }
  try {
    const data = readFileSync(path, "utf-8");
    return normalizeState(JSON.parse(data));
  } catch {
    return null;
  }
}

export function writeState(state: WorkflowState): void {
  ensureDir();
  const normalized = normalizeState(state);
  normalized.updatedAt = Date.now();
  const path = join(PW_DIR(), STATE_FILE);
  writeFileSync(path, JSON.stringify(normalized, null, 2));
}

// ─── Initialise / Reset ─────────────────────────────────────────────────

export function initState(): WorkflowState {
  ensureDir();

  const existing = (() => {
    try {
      return readState();
    } catch {
      return null;
    }
  })();
  const roleModels = existing?.roleModels ?? {};
  const context = existing?.context ?? {};

  try {
    const gitDir = join(process.cwd(), ".git");
    if (!existsSync(gitDir)) {
      console.log(`[pworkflow] Running git init in ${process.cwd()}`);
      const result = spawnSync("git", ["init"], {
        cwd: process.cwd(),
        stdio: "inherit",
        timeout: 10_000,
      });
      if (result.status === 0 && existsSync(gitDir)) {
        const logDir = join(process.cwd(), ".pworkflow");
        if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
        const logPath = join(logDir, "git-init.log");
        appendFileSync(
          logPath,
          `${new Date().toISOString()} - git repo initialized in ${process.cwd()}\n`,
        );
      } else {
        console.warn(
          `[pworkflow] git init failed with status ${result.status} or .git not found after init`,
        );
      }
    }
  } catch (err) {
    console.warn(`[pworkflow] Could not run git init: ${err}`);
  }

  const state = normalizeState({
    phase: "plan",
    currentStepId: "plan.dev",
    role: "dev",
    nextRole: "qa",
    stepIndex: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: "in_progress",
    devTaskFile: join(PW_DIR(), "task-dev.json"),
    qaTaskFile: join(PW_DIR(), "task-qa.json"),
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    roleModels,
    context,
  });
  writeState(state);
  return state;
}

export function getRoleModel(
  role: WorkflowRole,
  state: WorkflowState,
): string | undefined {
  return state.roleModels?.[role];
}

export function setRoleModel(
  role: WorkflowRole,
  modelId: string,
  state: WorkflowState,
): void {
  if (!state.roleModels) state.roleModels = {};
  state.roleModels[role] = modelId;
  writeState(state);
}

export function resetState(): void {
  const pwDir = PW_DIR();

  for (const f of ["task-dev.json", "task-qa.json"]) {
    const fp = join(pwDir, f);
    if (existsSync(fp)) {
      try {
        unlinkSync(fp);
      } catch {}
    }
  }

  try {
    const existing = readState();
    const roleModels = existing?.roleModels ?? {};
    const context = existing?.context ?? {};

    const state = normalizeState({
      phase: "plan",
      currentStepId: "plan.dev",
      role: "dev",
      nextRole: "qa",
      stepIndex: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: "in_progress",
      devTaskFile: join(pwDir, "task-dev.json"),
      qaTaskFile: join(pwDir, "task-qa.json"),
      confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
      roleModels,
      context,
    });
    writeState(state);
  } catch {}
}

// ─── Workflow Queries ───────────────────────────────────────────────────

export function getCurrentStep(state: Partial<WorkflowState>): WorkflowStep {
  return getStepAt(state);
}

export function getStepById(stepId: StepId): WorkflowStep | undefined {
  return WORKFLOW_STEPS.find((step) => step.id === stepId);
}

export function currentStepUsesSubtasks(state: Partial<WorkflowState>): boolean {
  return getCurrentStep(state).subtaskLoop === true;
}

export function currentStepDevHandsOffToQa(state: Partial<WorkflowState>): boolean {
  const step = getCurrentStep(state);
  return step.role === "dev" && step.onSuccess !== "complete";
}

export function isDevTurn(state: WorkflowState): boolean {
  return state.role === "dev";
}

export function isQaTurn(state: WorkflowState): boolean {
  return state.role === "qa";
}

export function isWorkflowComplete(state: WorkflowState): boolean {
  return state.status === "completed";
}

export function isWorkflowBlocked(state: WorkflowState): boolean {
  return state.status === "blocked";
}

// ─── Task files ─────────────────────────────────────────────────────────

export function writeTaskFile(role: WorkflowRole, task: string): void {
  ensureDir();
  const path = join(PW_DIR(), `task-${role}.json`);
  const payload = { task, assignedAt: Date.now() };
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

export function clearTaskFile(role: WorkflowRole): void {
  const path = join(PW_DIR(), `task-${role}.json`);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

// ─── Engine ─────────────────────────────────────────────────────────────

function outcomeScore(outcome: ParsedAgentOutcome, role: WorkflowRole): number | undefined {
  return role === "dev" ? outcome.devScore : outcome.qaScore;
}

export function hasRequiredScore(
  state: Partial<WorkflowState>,
  outcome: ParsedAgentOutcome,
): boolean {
  const step = getCurrentStep(state);
  return outcomeScore(outcome, step.requiredScoreOwner) !== undefined;
}

export function scoreSum(state: Partial<WorkflowState>): number {
  return (state.context?.devScore ?? 0) + (state.context?.qaScore ?? 0);
}

function resolveTarget(
  step: WorkflowStep,
  target: StepTarget | undefined,
  state: Partial<WorkflowState>,
): StepId | "complete" {
  if (!target || target === "next-step") {
    const idx = WORKFLOW_STEPS.findIndex((s) => s.id === step.id);
    return WORKFLOW_STEPS[idx + 1]?.id ?? "complete";
  }

  if (target === "retry-current-role") return step.id;

  if (target === "next-role") {
    const idx = WORKFLOW_STEPS.findIndex((s) => s.id === step.id);
    const nextRoleStep = WORKFLOW_STEPS
      .slice(idx + 1)
      .find((candidate) => candidate.role !== step.role);
    return nextRoleStep?.id ?? step.id;
  }

  if (target === "human") return step.id;

  return target;
}

function routeTransition(
  state: WorkflowState,
  targetStepId: StepId,
  message: string,
): WorkflowTransition {
  const targetStep = getStepById(targetStepId);
  if (!targetStep) {
    return {
      type: "reinject-current-step",
      step: getCurrentStep(state),
      reason: `Unknown target step: ${targetStepId}`,
    };
  }

  return {
    type: "route",
    step: getCurrentStep(state),
    targetStepId: targetStep.id,
    nextRole: targetStep.role,
    message,
  };
}

function advanceTransition(
  state: WorkflowState,
  targetStepId: StepId | "complete",
  message: string,
): WorkflowTransition {
  if (targetStepId === "complete") {
    return {
      type: "complete",
      step: getCurrentStep(state),
      message,
    };
  }

  const targetStep = getStepById(targetStepId);
  if (!targetStep) {
    return {
      type: "reinject-current-step",
      step: getCurrentStep(state),
      reason: `Unknown target step: ${targetStepId}`,
    };
  }

  return {
    type: "advance",
    step: getCurrentStep(state),
    targetStepId: targetStep.id,
    nextRole: targetStep.role,
    message,
  };
}

export function resolveTransition(
  state: WorkflowState,
  outcome: ParsedAgentOutcome,
): WorkflowTransition {
  const step = getCurrentStep(state);
  const normalizedOutcome = { ...outcome };

  if (normalizedOutcome.statusTag === "BLOCKER") {
    return {
      type: "blocked",
      step,
      message:
        `Blocked by ${step.role} — human intervention required.\n\n` +
        (normalizedOutcome.rawMessage ?? "").substring(0, 1000),
    };
  }

  if (
    normalizedOutcome.statusTag === "FAILURE" &&
    step.role === "qa" &&
    normalizedOutcome.qaScore === undefined
  ) {
    normalizedOutcome.qaScore = 0;
  }

  if (
    normalizedOutcome.statusTag === "SUCCESS" &&
    step.role === "qa" &&
    normalizedOutcome.qaScore === undefined
  ) {
    normalizedOutcome.qaScore = 100;
  }

  if (!hasRequiredScore(state, normalizedOutcome)) {
    return {
      type: "reinject-current-step",
      step,
      reason: `Missing required [${step.scoreTag}:N] score for ${step.id}.`,
    };
  }

  const activeScore = outcomeScore(normalizedOutcome, step.role);
  if (activeScore === undefined) {
    return {
      type: "reinject-current-step",
      step,
      reason: `Missing required [${step.scoreTag}:N] score for ${step.id}.`,
    };
  }

  // Dev turns hand off to the configured next step. QA owns the combined-score gate.
  if (step.role === "dev") {
    const target = resolveTarget(step, step.onSuccess, state);
    const targetStep = target === "complete" ? undefined : getStepById(target);
    return advanceTransition(
      state,
      target,
      targetStep
        ? `${step.name} submitted. Next: ${targetStep.name}.`
        : `${step.name} submitted. Workflow complete.`,
    );
  }

  const combined =
    (state.context.devScore ?? normalizedOutcome.devScore ?? 0) +
    (state.context.qaScore ?? normalizedOutcome.qaScore ?? 0);
  const threshold = state.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  if (combined >= threshold) {
    if (step.subtaskLoop && hasMoreSubtasks(state)) {
      return {
        type: "advance-subtask",
        step,
        targetStepId: step.id,
        nextRole: "dev",
        message: `Build subtask approved (${combined} >= ${threshold}). Moving to the next subtask.`,
      };
    }

    return advanceTransition(
      state,
      resolveTarget(step, step.onSuccess, state),
      `Threshold met (${combined} >= ${threshold}). Advancing workflow.`,
    );
  }

  const lowTarget = resolveTarget(step, step.onLowScore, state);
  const lowStep = getStepById(lowTarget);
  return routeTransition(
    state,
    lowTarget,
    `Threshold not met (${combined} < ${threshold}). Routing to ${lowStep?.name ?? lowTarget}.`,
  );
}

export function moveToStep(
  state: WorkflowState,
  stepId: StepId,
  options: {
    resetSubtasks?: boolean;
    clearScores?: boolean;
    preserveNextRole?: boolean;
  } = {},
): WorkflowState | null {
  const idx = WORKFLOW_STEPS.findIndex((step) => step.id === stepId);
  if (idx < 0) return null;

  const next = WORKFLOW_STEPS[idx];
  state.stepIndex = idx;
  state.currentStepId = next.id;
  state.phase = next.phase;
  state.status = "in_progress";

  if (next.subtaskLoop) {
    if (options.resetSubtasks) {
      state.currentSubtaskIndex = 0;
      state.subtasksCompleted = [];
    }
  } else {
    delete state.currentSubtaskIndex;
    delete state.subtasksCompleted;
  }

  if (options.clearScores) {
    state.context.devScore = undefined;
    state.context.qaScore = undefined;
  }

  if (!options.preserveNextRole) {
    state.nextRole = next.role;
  }

  writeState(state);
  return state;
}

export function advanceStep(
  state: WorkflowState,
  targetStepId: StepTarget = "next-step",
): WorkflowState | null {
  debugLog("### advanceStep", state);
  const current = getCurrentStep(state);
  const target = resolveTarget(current, targetStepId, state);
  if (target === "complete") return null;
  return moveToStep(state, target, {
    resetSubtasks: true,
    clearScores: current.role !== "dev",
  });
}

export function applyTransition(
  state: WorkflowState,
  transition: WorkflowTransition,
): WorkflowState {
  switch (transition.type) {
    case "blocked":
      return markBlocked(state, transition.message);

    case "complete":
      return markCompleted(state, transition.message);

    case "reinject-current-step":
      state.status = "in_progress";
      state.nextRole = state.role;
      writeState(state);
      return state;

    case "advance":
      moveToStep(state, transition.targetStepId, {
        resetSubtasks: true,
        clearScores: transition.step.role !== "dev",
      });
      state.nextRole = transition.nextRole;
      writeState(state);
      return state;

    case "advance-subtask":
      state.context.devScore = undefined;
      state.context.qaScore = undefined;
      advanceSubtask(state);
      state.nextRole = transition.nextRole;
      writeState(state);
      return state;

    case "route":
      moveToStep(state, transition.targetStepId, {
        resetSubtasks: false,
        clearScores: false,
        preserveNextRole: true,
      });
      state.nextRole = transition.nextRole;
      writeState(state);
      return state;
  }
}

// ─── Escalate / Complete ────────────────────────────────────────────────

export function markBlocked(
  state: WorkflowState,
  notes?: string,
): WorkflowState {
  state.status = "blocked";
  state.context.notes = notes || "Blocked — human intervention required";
  writeState(state);
  return state;
}

export function markFailed(
  state: WorkflowState,
  reason?: string,
): WorkflowState {
  state.status = "failed";
  state.context.notes = reason || "Workflow failed";
  writeState(state);
  return state;
}

export function markCompleted(
  state: WorkflowState,
  reason?: string,
): WorkflowState {
  state.status = "completed";
  state.context.notes = reason || "Workflow completed successfully";
  writeState(state);
  return state;
}

// ─── Subtasks ───────────────────────────────────────────────────────────

export function getSubtaskOrder(): string[] | null {
  const path = join(PW_DIR(), "task-order.json");
  if (!existsSync(path)) return null;
  try {
    const data = readFileSync(path, "utf-8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function hasMoreSubtasks(state: Partial<WorkflowState>): boolean {
  if (!currentStepUsesSubtasks(state)) return false;
  const order = getSubtaskOrder();
  if (!order || order.length === 0) return false;
  return (state.currentSubtaskIndex ?? 0) + 1 < order.length;
}

export function getCurrentSubtask(state: WorkflowState): string | null {
  const order = getSubtaskOrder();
  if (!order) return null;

  const currentIndex = state.currentSubtaskIndex ?? 0;
  if (currentIndex >= order.length) return null;

  return order[currentIndex];
}

export function advanceSubtask(state: WorkflowState): boolean {
  if (!currentStepUsesSubtasks(state)) return false;

  const order = getSubtaskOrder();
  if (!order) return false;

  if (!state.subtasksCompleted) state.subtasksCompleted = [];
  const currentIndex = state.currentSubtaskIndex ?? 0;
  if (!state.subtasksCompleted.includes(currentIndex)) {
    state.subtasksCompleted.push(currentIndex);
  }

  const newIndex = currentIndex + 1;
  if (newIndex >= order.length) {
    delete state.currentSubtaskIndex;
    delete state.subtasksCompleted;
    state.nextRole = "dev";
    writeState(state);
    return false;
  }

  state.currentSubtaskIndex = newIndex;
  state.nextRole = "dev";
  writeState(state);
  return true;
}

export function resetBuildTracking(state: WorkflowState): void {
  const order = getSubtaskOrder();
  if (!order || order.length === 0) return;

  state.currentSubtaskIndex = 0;
  state.subtasksCompleted = [];
  writeState(state);
}

export function getSubtaskProgress(state: WorkflowState): {
  total: number;
  completed: number;
} {
  const order = getSubtaskOrder();
  if (!currentStepUsesSubtasks(state)) return { total: 0, completed: 0 };
  if (!order) return { total: 0, completed: 0 };

  const completed = state.subtasksCompleted?.length ?? 0;
  const current = state.currentSubtaskIndex ?? 0;
  const total = order.length;
  return {
    total,
    completed: Math.min(completed + (current > 0 ? 1 : 0), total),
  };
}

// ─── Misc ───────────────────────────────────────────────────────────────

export function ensureDir(): void {
  const dir = PW_DIR();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function PW_DIR(): string {
  return join(process.cwd(), ".pworkflow");
}

/** Sync the mtime of a task file to prevent re-firing pollers. */
export function syncTaskFileMtime(role: "dev" | "qa"): void {
  const taskFile = role === "qa" ? "task-qa.json" : "task-dev.json";
  const taskPath = join(PW_DIR(), taskFile);
  try {
    if (existsSync(taskPath)) {
      const st = statSync(taskPath);
      writeFileSync(taskPath, readFileSync(taskPath), {
        mode: st.mode,
      });
    }
  } catch {}
}
