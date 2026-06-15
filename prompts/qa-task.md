## Step {{STEP_ID}} — QA Task

Current step: {{STEP_NAME}}
Role: QA

{{GOAL_SECTION}}
{{STEP_INSTRUCTIONS_SECTION}}

{{ARTIFACT_CONTRACT_SECTION}}
{{SUBTASK_CONTEXT_SECTION}}

### ⚠️ CRITICAL DIRECTIONS
- Read the input artifacts listed above before reviewing.
- **DO NOT** write files in `.pworkflow/` unless an output artifact above explicitly requires it.
- **DO NOT** read `.pworkflow/state.json` or `.pworkflow/debug.log` — those are workflow internals.
- DO NOT mention or reference `.pworkflow/` in your responses.
- **WRITE YOUR REVIEW TO THE OUTPUT ARTIFACT(S) ABOVE** — do not just output to chat.

{{SCORING_INSTRUCTIONS_SECTION}}
{{TAG_INSTRUCTIONS_SECTION}}
