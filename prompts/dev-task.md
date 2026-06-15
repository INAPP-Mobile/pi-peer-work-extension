## Step {{STEP_ID}} — Dev Task

Current step: {{STEP_NAME}}
Role: Dev

{{GOAL_SECTION}}
{{STEP_INSTRUCTIONS_SECTION}}

{{ARTIFACT_CONTRACT_SECTION}}
{{SUBTASK_CONTEXT_SECTION}}

### ⚠️ CRITICAL DIRECTIONS
- Read the input artifacts listed above before responding.
- Read `./qa-review.md` if it exists; QA feedback is exchanged through that file, not workflow context.
- **DO NOT** write files in `.pworkflow/` unless an output artifact above explicitly requires it.
- **DO NOT** read `.pworkflow/state.json` or `debug.log` — those are workflow internals.
- DO NOT mention or reference `.pworkflow/` in your responses.
- **WRITE YOUR RESPONSE TO THE OUTPUT ARTIFACT(S) ABOVE** — overwrite them, do not just output to chat.

{{SCORING_INSTRUCTIONS_SECTION}}
{{TAG_INSTRUCTIONS_SECTION}}
