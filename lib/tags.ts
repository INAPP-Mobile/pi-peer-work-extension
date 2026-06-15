// ─── Score and Status Parsing ───────────────────────────────────────────
//
// Parse [DEVSCORE:N] and [QA_SCORE:N] scores from agent messages.
// Legacy status tags are parsed for escalation/status behavior:
//   - [FAILURE] -> low QA score; normal threshold flow routes next turn to Dev
//   - [BLOCKER] -> mark workflow blocked and notify human/Telegram

export type ScoreResult = {
  devScore?: number;
  qaScore?: number;
  invalidScores?: ("devScore" | "qaScore")[];
};

export type StatusTag = "SUCCESS" | "FAILURE" | "BLOCKER";

export type ParsedWorkflowTags = ScoreResult & {
  statusTag?: StatusTag;
};

function parseScoreValue(raw: string, key: "devScore" | "qaScore"): number | undefined {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    return undefined;
  }
  return value;
}

export function parseScores(text: string): ScoreResult {
  const result: ScoreResult = {
    devScore: undefined,
    qaScore: undefined,
    invalidScores: [],
  };
  const upper = text.toUpperCase();

  // [DEVSCORE:N] - exact format, no underscores or spaces allowed
  const devMatch = upper.match(/\[DEVSCORE:(\d+)\]/);
  if (devMatch) {
    const score = parseScoreValue(devMatch[1], "devScore");
    if (score === undefined) {
      result.invalidScores!.push("devScore");
    } else {
      result.devScore = score;
    }
  }

  // [QA_SCORE:N] - exact format
  const qaMatch = upper.match(/\[QA_SCORE:(\d+)\]/);
  if (qaMatch) {
    const score = parseScoreValue(qaMatch[1], "qaScore");
    if (score === undefined) {
      result.invalidScores!.push("qaScore");
    } else {
      result.qaScore = score;
    }
  }

  if ((result.invalidScores ?? []).length === 0) {
    delete result.invalidScores;
  }

  return result;
}

export function parseWorkflowTags(text: string): ParsedWorkflowTags {
  const scores = parseScores(text);
  const upper = text.toUpperCase();
  const tagMatch = upper.match(/\[(SUCCESS|FAILURE|BLOCKER)\]/);

  return {
    ...scores,
    statusTag: tagMatch ? (tagMatch[1] as StatusTag) : undefined,
  };
}
