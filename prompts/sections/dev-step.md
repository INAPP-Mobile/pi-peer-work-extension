### Current Step Instructions
Step: {{STEP_ID}} — {{STEP_NAME}}
Role: {{STEP_ROLE}}

{{STEP_DESCRIPTION}}

Follow the current step and artifact contract below. Do not infer workflow behavior from phase names.

- Read every input artifact listed above before doing work.
- If this is a retry after QA, read `./qa-review.md` if it exists, then address that feedback in the declared output artifact(s).
- If the step has a subtask loop, use the "Subtask Loop" section and work only on the current subtask.
- Write only to the output artifact(s) listed in the artifact contract.
- Do not write files in `.pworkflow/` unless an output artifact above explicitly requires it.
- After writing the output artifact(s), include the required score tag in your response.
