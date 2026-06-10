# pi-peer-work Extension

A peer workflow extension for the [pi-coding-agent](https://github.com/earendil-works/pi) that enables async build/release pipeline between dev and QA roles.

## Overview

This extension implements a two-phase workflow:

```
PLAN   → dev plans → qa reviews     → [SUCCESS]→BUILD
BUILD  → dev builds → qa reviews    → [SUCCESS]→RELEASE
RELEASE → dev deploys → qa confirms → [SUCCESS]→DONE
```

Each step requires explicit approval tags (`[SUCCESS]`, `[FAILURE]`, or `[BLOCKER]`) in the output.

## Features

- **Two-phase pipeline**: PLAN → BUILD → RELEASE
- **Role-based workflow**: Alternates between `dev` and `qa` roles
- **State persistence**: Maintains workflow state in `.pworkflow/state.json`
- **Task files**: Automatic task generation for each role's turn
- **Telegram notifications**: Escalation support via Telegram

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
export PWORKFLOW_ROLE=dev   # or qa
pi
```

Or use the agent command to set it per-session.

### Check Status

```
/pworkflow-status
```

Shows current phase, step, and workflow state.

## Workflow Steps

### PLAN Phase
1. **Dev**: Plan the project (architecture, dependencies, implementation approach)
2. **QA**: Review plan output and approve/deny

### BUILD Phase
1. **Dev**: Build the project (compile, test, lint)
2. **QA**: Review build artifacts and approve/deny

### RELEASE Phase
1. **Dev**: Deploy and publish artifacts
2. **QA**: Confirm release is live and working

## Configuration

No additional configuration required beyond setting `PWORKFLOW_ROLE`.

## License

MIT
