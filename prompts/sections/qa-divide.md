### Divide Phase Review

Review the dev's subtask division:

1. Read all subtask files in `doc/task-*.md`
2. Read `.pworkflow/task-order.json` to verify execution order
3. Verify:
   - All subtasks are under 8k token budget when implemented
   - Subtasks are in correct execution order (no circular dependencies)
   - No gaps or missing steps between subtasks
   - Each subtask is actionable and testable

**WRITE YOUR REVIEW TO "./qa-review.md"** (overwrite this file) — do not just output to chat.

Include `[QA_SCORE:N]` (0-100) scoring confidence in the subtask plan.
Use a low score with detailed feedback when issues are found; the system will push the task back to Dev for revision.
