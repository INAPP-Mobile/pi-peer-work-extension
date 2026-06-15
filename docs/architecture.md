# pworkflow Architecture Proposal

## Objective

pworkflow should be a **restartable, file-based peer workflow engine** for long-running coding tasks.

Core goals:

- Keep agent context small.
- Use files as durable Dev/QA handoff artifacts.
- Avoid storing large feedback/content in workflow state.
- Follow the natural turn flow instead of forcing mid-flow redirects.
- Make workflow expansion data-driven through a central step list.
- Keep `agent_end` simple: parse outcome, update state, route next step.

## Current Direction

The workflow is moving away from phase-specific branching like:

```ts
if (state.phase === "build") { ... }
if (isDividePhase(state)) { ... }
failBackToDev(...)
```

Toward a central step model:

```ts
WORKFLOW_STEPS
currentStepUsesSubtasks(...)
currentStepDevHandsOffToQa(...)
advanceStep(...)
```

The next rearchitecture should complete that direction.

## Proposed Architecture

### 1. Step Graph as Source of Truth

Define the workflow as a graph/list of steps.

Each phase can contain one or more steps.

Example:

```ts
type WorkflowPhase = "plan" | "divide" | "build" | "release";
type WorkflowRole = "dev" | "qa";
type StepId = string;

interface WorkflowStep {
  id: StepId;
  phase: WorkflowPhase;
  name: string;
  role: WorkflowRole;
  description: string;

  inputArtifacts: string[];
  outputArtifacts: string[];

  scoreTag: "DEVSCORE" | "QA_SCORE";
  requiredScoreOwner: WorkflowRole;

  onSuccess?: StepId | "complete" | "next-step";
  onLowScore?: StepId | "retry-current-role" | "next-role";
  onBlocker?: "human";

  subtaskLoop?: boolean;
}
```

Example step graph:

```ts
[
  {
    id: "plan.dev",
    phase: "plan",
    name: "Plan Dev",
    role: "dev",
    inputArtifacts: [],
    outputArtifacts: ["plan.md"],
    scoreTag: "DEVSCORE",
    requiredScoreOwner: "dev",
    onSuccess: "plan.qa",
    onLowScore: "retry-current-role"
  },
  {
    id: "plan.qa",
    phase: "plan",
    name: "Plan QA",
    role: "qa",
    inputArtifacts: ["plan.md"],
    outputArtifacts: ["qa-review.md"],
    scoreTag: "QA_SCORE",
    requiredScoreOwner: "qa",
    onSuccess: "divide.dev",
    onLowScore: "plan.dev"
  },
  {
    id: "divide.dev",
    phase: "divide",
    name: "Divide Dev",
    role: "dev",
    inputArtifacts: ["plan.md"],
    outputArtifacts: ["doc/task-*.md", ".pworkflow/task-order.json"],
    scoreTag: "DEVSCORE",
    requiredScoreOwner: "dev",
    onSuccess: "divide.qa",
    onLowScore: "retry-current-role"
  },
  {
    id: "divide.qa",
    phase: "divide",
    name: "Divide QA",
    role: "qa",
    inputArtifacts: ["doc/task-*.md", ".pworkflow/task-order.json"],
    outputArtifacts: ["qa-review.md"],
    scoreTag: "QA_SCORE",
    requiredScoreOwner: "qa",
    onSuccess: "build.dev",
    onLowScore: "divide.dev"
  },
  {
    id: "build.dev",
    phase: "build",
    name: "Build Dev",
    role: "dev",
    inputArtifacts: ["doc/task-*.md", ".pworkflow/task-order.json"],
    outputArtifacts: ["build-output.md"],
    scoreTag: "DEVSCORE",
    requiredScoreOwner: "dev",
    onSuccess: "build.qa",
    onLowScore: "retry-current-role",
    subtaskLoop: true
  },
  {
    id: "build.qa",
    phase: "build",
    name: "Build QA",
    role: "qa",
    inputArtifacts: ["build-output.md", "doc/task-*.md", ".pworkflow/task-order.json"],
    outputArtifacts: ["qa-review.md"],
    scoreTag: "QA_SCORE",
    requiredScoreOwner: "qa",
    onSuccess: "next-step",
    onLowScore: "build.dev"
  },
  {
    id: "release.dev",
    phase: "release",
    name: "Release Dev",
    role: "dev",
    inputArtifacts: ["build-output.md"],
    outputArtifacts: ["release-output.md"],
    scoreTag: "DEVSCORE",
    requiredScoreOwner: "dev",
    onSuccess: "release.qa",
    onLowScore: "retry-current-role"
  },
  {
    id: "release.qa",
    phase: "release",
    name: "Release QA",
    role: "qa",
    inputArtifacts: ["release-output.md"],
    outputArtifacts: ["qa-review.md"],
    scoreTag: "QA_SCORE",
    requiredScoreOwner: "qa",
    onSuccess: "complete",
    onLowScore: "release.dev"
  }
]
```

## 2. State Shape

State should store navigation and scores, not large content.

```ts
interface WorkflowState {
  phase: WorkflowPhase;
  currentStepId: StepId;
  role: WorkflowRole;
  nextRole: WorkflowRole;
  stepIndex: number;

  status: "in_progress" | "completed" | "blocked" | "failed";

  startedAt: number;
  updatedAt: number;

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
```

Important:

- Do **not** store `qaFeedback` or full QA messages in state.
- Do **not** store full Dev output in state.
- Store only references and scores.
- Content lives in artifact files.

## 3. Artifact Contract

Each step declares inputs and outputs.

This should drive prompts.

Example:

```ts
step.inputArtifacts = ["plan.md"];
step.outputArtifacts = ["qa-review.md"];
```

Prompt generation should say:

```md
Read these artifacts:
- plan.md

Write your result to:
- qa-review.md
```

This removes special casing like:

```ts
if role === "qa" write qa-review.md
if role === "dev" write plan.md
```

The extension should not own role-specific file-writing helpers. The prompt/artifact contract owns file handoff.

## 4. Engine Rules

`agent_end` should not decide workflow semantics with scattered `if` statements.

It should:

1. Parse the agent message.
2. Validate required score.
3. Pass outcome to engine.
4. Engine resolves next state.

Pseudo-flow:

```ts
function handleAgentEnd(state, parsed): WorkflowTransition {
  if (parsed.statusTag === "BLOCKER") {
    return engine.block(state, parsed);
  }

  if (!engine.hasRequiredScore(state, parsed)) {
    return engine.reinjectCurrentStep(state);
  }

  const scoreSum = engine.scoreSum(state);

  if (scoreSum >= state.confidenceThreshold) {
    return engine.advance(state);
  }

  return engine.routeLowScore(state);
}
```

No forced mid-flow role rewrite.

QA failure should simply produce a low `qaScore`; normal step routing sends the next turn to Dev.

## 5. Natural Routing

Preferred routing:

```txt
Dev submits artifact + score
→ QA reviews artifact + score
→ if threshold met: next step
→ if threshold not met: next natural role for revision
```

Avoid:

```txt
QA failure
→ engine forcibly rewrites state.role = "dev"
→ engine forcibly rewrites nextRole = "dev"
```

Instead:

```ts
onLowScore: "next-role"
```

or:

```ts
onLowScore: "build.dev"
```

The engine resolves it from step config.

## 6. Subtask Loop

Subtasks should be step behavior, not phase branching.

```ts
if (step.subtaskLoop) {
  use task-order.json;
  use currentSubtaskIndex;
}
```

Engine behavior:

```txt
build.dev
→ build.qa
→ if threshold met and more subtasks:
    build.dev with currentSubtaskIndex + 1
→ if threshold met and no more subtasks:
    release.dev
```

`agent_end` should not contain:

```ts
if (state.phase === "build") { ... }
```

It should only ask:

```ts
if (step.subtaskLoop) { ... }
```

## 7. Prompt Generation

Prompts should be generated from step metadata.

Inputs:

- step description
- input artifacts
- output artifacts
- score tag
- threshold
- optional subtask context

This keeps prompts aligned with workflow config.

Example generated section:

```md
## Current Step

Step: build.dev
Phase: build
Role: dev

Read:
- doc/task-003.md
- .pworkflow/task-order.json

Write your result to:
- build-output.md

Include score:
- [DEVSCORE:N]
```

## 8. File Layout

Suggested layout:

```txt
lib/
  workflow/
    graph.ts
    engine.ts
    state.ts
    artifacts.ts
  prompts/
    buildDevPrompt.ts
    buildQaPrompt.ts
  handlers/
    session.ts
    commands.ts
    tools.ts
  tags.ts
  logger.ts
  telegram.ts
```

Current project can migrate gradually without moving every file immediately.

Minimum first migration:

```txt
lib/workflow.ts        // graph + engine helpers
lib/session.ts         // only calls engine
lib/tasks.ts           // prompt generation from step metadata
lib/commands.ts        // status from current step
```

## 9. Commands

Commands should operate through the workflow engine.

Examples:

```ts
engine.init()
engine.reset()
engine.getStatus()
engine.retryCurrentStep()
engine.forceStep(stepId)
engine.markBlocked(reason)
```

Status should show:

```txt
Phase: BUILD
Current Step: build.qa
Role: qa
Status: in_progress
Input Artifacts:
- build-output.md
Output Artifacts:
- qa-review.md
```

## 10. Migration Plan

### Migration Status

All migration phases are implemented in the current codebase:

- Phase 1: `agent_end` delegates flow decisions to `resolveTransition` / `applyTransition`.
- Phase 2: `currentStepId` is stored and used for restarts.
- Phase 3: every workflow step declares input/output artifact contracts.
- Phase 4: task prompts are rendered from step metadata and artifact contracts instead of phase-specific branching.
- Phase 5: routing is resolved by the workflow engine from step config and scores.
- Phase 6: legacy feedback fields and hardcoded phase routing were removed from `session.ts`.

### Phase 1: Finish current step-list cleanup

Completed:

- `WORKFLOW_STEPS`
- `advanceStep`
- `currentStepUsesSubtasks`
- `currentStepDevHandsOffToQa`

`agent_end` has no direct phase checks.

### Phase 2: Add `currentStepId`

Completed. `stepIndex` remains for compatibility while `currentStepId` is the restart key.

```ts
state.currentStepId = WORKFLOW_STEPS[state.stepIndex].id;
```

### Phase 3: Add artifact contracts to steps

Completed. Prompt generation and status use step input/output artifact contracts.

Add:

```ts
inputArtifacts: string[];
outputArtifacts: string[];
```

Use them in prompt generation.

### Phase 4: Replace role-specific prompt branching

Completed. Prompts are rendered from the current step metadata, artifact contract, optional subtask context, and role scoring sections.

### Phase 5: Replace routing branches with engine resolver

Completed. `resolveTransition` owns routing decisions and `applyTransition` mutates state.

### Phase 6: Remove legacy fields

Completed:

- `qaFeedback` is removed during state normalization.
- `failBackToDev` no longer exists.
- forced `roundsToAdvance` was removed.
- hardcoded phase routing was removed from `session.ts`.

## Acceptance Criteria

The rearchitecture is successful when:

- `agent_end` does not check `state.phase` for flow decisions.
- Dev/QA file handoff is driven by artifact contracts, not role-specific helpers.
- QA feedback lives only in `qa-review.md`, not state.
- Dev output lives only in declared output artifacts, not state.
- QA failure routes naturally through scores and step config.
- Adding a new workflow step does not require editing `session.ts`.
- Adding a new phase does not require editing `agent_end`.
- Restarting from the middle works by reading state + artifact files.
