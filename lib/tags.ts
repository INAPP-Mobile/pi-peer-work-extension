// ─── Score-Only Parsing ────────────────────────────────────────────────
//
// Parse [DEVSCORE:N], [QA_SCORE:N] scores from agent messages.
// Tags ([SUCCESS], [FAILURE], [BLOCKER]) are now derived from scores:
//   - Success: devScore + qaScore >= threshold
//   - Failure: score sum < threshold or qaScore low indicates problems

export type ScoreResult = {
  devScore?: number;
  qaScore?: number;
};

export function parseScores(text: string): ScoreResult {
  const result: ScoreResult = {
    devScore: undefined,
    qaScore: undefined,
  };
  const upper = text.toUpperCase();

  // [DEVSCORE:N] - exact format, no underscores or spaces allowed
  const devMatch = upper.match(/\[DEVSCORE:(\d+)\]/);
  if (devMatch) {
    result.devScore = parseInt(devMatch[1], 10);
  }

  // [QA_SCORE:N] - exact format
  const qaMatch = upper.match(/\[QA_SCORE:(\d+)\]/);
  if (qaMatch) {
    result.qaScore = parseInt(qaMatch[1], 10);
  }

  return result;
}
