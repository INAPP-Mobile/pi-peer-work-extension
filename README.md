# pi-peer-work Extension

A peer workflow extension for the [pi-coding-agent](https://github.com/earendil-works/pi) that enables async build/release pipeline between dev and QA roles.

## Overview

This extension implements a restartable, file-based peer workflow engine:

```text
plan.dev  → plan.qa  → divide.dev → divide.qa → build.dev → build.qa → release.dev → release.qa → done
```

Each step declares its role, input artifacts, output artifacts, required score tag, and routing targets. Scores drive advancement; artifact files carry the durable Dev/QA handoff content.

Each step is determined by **step config and scoring thresholds**, not manual tags or scattered phase branches. Scores determine advancement:
- Dev submits its required score → route to the configured next step
- QA score + latest Dev score >= threshold → advance
- below threshold → route to the configured revision step

## Features

- **Step graph source of truth**: Central `WORKFLOW_STEPS` list owns routing, roles, scores, and artifacts
- **Restartable state**: Keeps navigation and scores in `.pworkflow/state.json` while content stays in artifact files
- **Artifact contracts**: Prompts are generated from each step's input/output artifact list
- **File-based handoffs**: Dev results and QA reviews live in artifact files such as `plan.md`, `qa-review.md`, `build-output.md`, and `release-output.md`
- **Telegram notifications**: Escalation support via Telegram
- **Context compaction**: `/compact` command to summarize old messages when context grows large

## Installation

1. Copy this extension to your pi agent extensions directory:
   ```
   ~/.pi/agent/extensions/
   ```

2. Add to your pi config (if not auto-loaded):
   ```json
   {
     "extensions": ["pi-peer-work-extension"]
   }
   ```

## Usage

### Initialize Workflow

```
/pworkflow-init
```

This:
- Creates `.pworkflow/` directory
- Sets up `.gitignore` entries
- Initializes git repo if not present
- Starts workflow at `plan.dev` (`dev` role)

### Set Your Role

For each terminal session, set your role:

```bash
pi
```

Or use the agent command to set it per-session.

### Check Status

```
/pworkflow-status
```

Shows current step, role, status, and artifact contract.

## Context Compaction

When the conversation grows too long for context window, use `/compact <instructions>` to summarize older messages while preserving recent work. The workflow keeps compaction enabled so long-running agents can continue without system OOM, then resumes from task files and `.pworkflow/state.json`.

Pi also auto-compacts when context exceeds threshold (configurable in `~/.pi/agent/settings.json`).

## Workflow Steps

### Plan Step Group
- **plan.dev**: Dev writes `plan.md` and includes `[DEVSCORE:N]`
- **plan.qa**: QA reads `plan.md`, writes `qa-review.md`, and includes `[QA_SCORE:N]`

**Advancement**: QA review passes threshold → `divide.dev`.

### Divide Step Group
- **divide.dev**: Dev writes `doc/task-*.md` and `.pworkflow/task-order.json`
- **divide.qa**: QA reads the task specs/order and writes `qa-review.md`

**Advancement**: Threshold met → `build.dev`. Not met → configured Dev revision step.

### Build Step Group
- **build.dev**: Dev implements one subtask from `doc/<task>.md` and writes `build-output.md`
- **build.qa**: QA reads the current subtask and output, then writes `qa-review.md`

**Advancement**: Threshold met → next subtask, or `release.dev` when all subtasks are complete. Not met → configured Dev revision step.

### Release Step Group
- **release.dev**: Dev deploys/publishes and writes `release-output.md`
- **release.qa**: QA confirms deployment and writes `qa-review.md`

**Advancement**: Threshold met → workflow complete.

## Configuration

Edit `.pworkflow/state.json` to adjust the top-level `confidenceThreshold`:

```json
{
  "confidenceThreshold": 180
}
```

Default threshold: `180` (sum of devScore + qaScore, max 200).

## License

MIT
