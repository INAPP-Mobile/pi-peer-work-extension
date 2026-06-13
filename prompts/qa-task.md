## {{PHASE}} Phase — QA Task

Step: {{STEP_DESCRIPTION}}

{{GOAL_SECTION}}
{{PHASE_INSTRUCTIONS_SECTION}}

### ⚠️ CRITICAL DIRECTIONS
- Read the dev's previous response from document files
- **DO NOT** write files in `.pworkflow/` — that folder is for workflow metadata only
- **DO NOT** read `.pworkflow/state.json` or `.pworkflow/debug.log` — those are workflow internals
- DO NOT mention or reference `.pworkflow/` in your responses
- **WRITE YOUR REVIEW TO A DOCUMENT FILE** - do not just output to chat

{{SCORING_INSTRUCTIONS_SECTION}}
### ⚠️ STRICT FORMAT REQUIREMENT
- Use `[DEVSCORE:N]` (no spaces, no underscores) for dev scores
- Use `[QA_SCORE:N]` (exact) for QA scores
- Scores outside this format will NOT be detected by the system

If threshold is not met, you will be asked to reverify.
