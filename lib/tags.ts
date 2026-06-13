// ─── Tag / Score Parsing ─────────────────────────────────────────────────
//
// Parse [SUCCESS], [FAILURE], [BLOCKER] tags and [DEVSCORE:N], [QA_SCORE:N]
// scores from agent messages.

export type QaTag = "success" | "failure" | "blocker" | null;

export type ScoreResult = {
  tag: QaTag;
  devScore?: number;
  qaScore?: number;
};

export function parseScores(text: string): {
  devScore?: number;
  qaScore?: number;
} | null {
  const result: { devScore?: number; qaScore?: number } = {};
  const upper = text.toUpperCase();

  // [DEVSCORE:90], [DEV_SCORE:90], [DEVSCORE 90], [DEV_SCORE90]
  const devMatch = upper.match(/\[DEV_?SCORE(?::\s*)?(\d+)\]/);
  if (devMatch) {
    result.devScore = parseInt(devMatch[1], 10);
  }

  // [QA_SCORE:94], [QASCORE:94], [QA_SCORE 94]
  const qaMatch = upper.match(/\[QA_?SCORE(?::\s*)?(\d+)\]/);
  if (qaMatch) {
    result.qaScore = parseInt(qaMatch[1], 10);
  }

  // Return null only if neither score found
  if (!devMatch && !qaMatch) return null;

  return result;
}
