# pi-peer-work Extension

A peer workflow extension for the [pi-coding-agent](https://github.com/earendil-works/pi) that enables async build/release pipeline between dev and QA roles.

## Overview

This extension implements a two-phase workflow:

```
PLAN   → dev plans → qa reviews     → [SUCCESS]→BUILD
BUILD  → dev builds → qa reviews    → [SUCCESS]→RELEASE
RELEASE → dev deploys → qa confirms → [SUCCESS]→DONE
```

Each step is determined by **scoring thresholds**, not manual tags.scores determine advancement:
- `devScore + qaScore >= threshold` → advance to next phase
- below threshold → continue revising

## Features

- **Two-phase pipeline**: PLAN → BUILD → RELEASE
- **Role-based workflow**: Alternates between `dev` and `qa` roles
- **State persistence**: Maintains workflow state in `.pworkflow/state.json`
- **Task files**: Automatic task generation for each role's turn
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
- Starts workflow at `PLAN` phase, `dev` role first

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

Shows current phase, step, and workflow state.

## Context Compaction

When the conversation grows too long for context window, use `/compact <instructions>` to summarize older messages while preserving recent work. Your extension's `/pworkflow-compact` tool wraps this with role-specific follow-up messages after compaction.

Pi also auto-compacts when context exceeds threshold (configurable in `~/.pi/agent/settings.json`).

## Workflow Steps

### PLAN Phase
1. **Dev**: Plan the project (architecture, dependencies, implementation approach)
2. **QA**: Review plan output and score confidence (0-100 each)

**Advancement**: When `devScore + qaScore >= threshold`, move to BUILD phase.

### BUILD Phase
1. **Dev**: Build the project (compile, test, lint)
2. **QA**: Review build artifacts and score confidence

**Advancement**: Threshold met → RELEASE. Not met → dev revises.

### RELEASE Phase
1. **Dev**: Deploy and publish artifacts
2. **QA**: Confirm release is live and working

**Advancement**: Threshold met → DONE.

## Configuration

Edit `.pworkflow/state.json` to adjust:

```json
{
  "context": {
    "confidenceThreshold": 180
  }
}
```

Default threshold: `180` (sum of devScore + qaScore, max 200).

## License

MIT
