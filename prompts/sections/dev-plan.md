### ⚠️ WARNING: Plan Phase — No Code Allowed
**YOU ARE IN THE PLAN PHASE. YOUR JOB IS TO WRITE A PLAN DOCUMENT, NOT CODE.**
**DO NOT write any source code, run any commands, or produce any build artifacts.**
**DO NOT create files, install packages, or modify the project.**

Your response will be evaluated by QA. If you write code instead of a plan, you
will be FAILED and sent back to plan again. Only text-based plans are accepted right now.

### ✅ What To Do — Write A Plan
1. Research the project requirements and constraints
2. Propose a comprehensive build plan with architecture decisions
3. Identify potential risks and mitigation strategies
4. **WRITE YOUR PLAN TO A DOCUMENT FILE** (e.g., `plan.md`, `summary.txt`) - do not just output to chat
5. Include `[DEVSCORE:N]` tag (0-100) indicating your confidence in the plan
6. After QA reviews, include `[QA_SCORE:N]` tag (0-100) scoring QA's review
7. Iterate until combined score >= threshold (`{{CONFIDENCE_THRESHOLD}}`)
### ⚠️ STRICT FORMAT REQUIREMENT FOR SCORES
The system parses scores using regex — **exact format required**:
- `[DEVSCORE:90]` is valid (no space, no underscore between DEV and SCORE)
- `[DEV_SCORE:90], [DEV SCORE:90`, `Dev score: 90/100` are INVALID
- Violations result in `No score found in message` → task reinjection
