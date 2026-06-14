### Scoring Instructions
- Use `[DEVSCORE:N]` to self-score your plan quality (0-100).
- Do not use `[QA_SCORE:N]`; QA will provide that score during review.
- Combined score must reach threshold (`{{CONFIDENCE_THRESHOLD}}`) to advance.

### ⚠️ STRICT FORMAT REQUIREMENT
- `[DEVSCORE:90]` is valid (no space, no underscore between DEV and SCORE)
- `[DEV_SCORE:90]`, `[DEV SCORE:90`, `Dev score: 90/100` are INVALID
- Violations result in `No score found in message` → task reinjection
