### Scoring Instructions
- Use `[DEVSCORE:N]` to score dev's plan (0-100)
- Use `[QA_SCORE:N]` for your review score (0-100)
- Combined score must reach threshold (`{{CONFIDENCE_THRESHOLD}}`) to advance

### ⚠️ STRICT FORMAT REQUIREMENT
- `[DEVSCORE:90]` is valid
- `[DEV_SCORE:90]`, `[DEV SCORE:90]`, `[DEVSCORE 90]` are INVALID
- `[QA_SCORE:94]` is valid
- `[QASCORE:94]`, `[QA SCORE:94]` are INVALID
- Scores outside this format will NOT be detected by the system
