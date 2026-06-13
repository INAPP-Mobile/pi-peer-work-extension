## {{PHASE}} Phase — Dev Task

Step: {{STEP_DESCRIPTION}}

{{GOAL_SECTION}}
{{PHASE_INSTRUCTIONS_SECTION}}

### ⚠️ CRITICAL DIRECTIONS
- Read QA's previous review response
- **DO NOT** write files in `.pworkflow/` — that folder is for workflow metadata only
- **DO NOT** read `.pworkflow/state.json` or `debug.log` — those are workflow internals
- DO NOT mention or reference `.pworkflow/` in your responses
- **WRITE YOUR RESPONSE TO A DOCUMENT FILE** (e.g., `response.md`, `dev-output.txt`) - do not just output to chat

{{SCORING_INSTRUCTIONS_SECTION}}
### ⚠️ STRICT FORMAT REQUIREMENT
- Use `[DEVSCORE:N]` (no spaces, no underscores) for dev scores
- Use `[QA_SCORE:N]` (exact) for QA scores
- Scores outside this format will NOT be detected by the system

If threshold is not met, you will be asked to reverify.
