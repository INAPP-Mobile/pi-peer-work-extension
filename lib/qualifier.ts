// ─── Qualifier: LLM Gate for Output Quality ─────────────────────────────
//
// Calls a local LLM to judge whether role output is substantive enough
// to advance the workflow. Prevents empty/question-only output from
// burning workflow steps.

import { readState, writeState, WorkflowState, Role, getRoleModel } from "./workflow";
import { debugLog } from "./logger";

export type QualifierVerdict = "pass" | "reject";
export type JudgeResult = { verdict: QualifierVerdict; raw: string };

interface QualifierConfig {
  /** Ollama model ID to use for judging. Default: lfm2.5 */
  model?: string;
  /** Ollama base URL. Default: http://localhost:11434/v1 */
  baseUrl?: string;
}

// ─── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_MODEL = "lfm2.5";
const DEFAULT_BASE_URL = "http://localhost:11434/v1";

function getQualifierConfig(): Required<QualifierConfig> {
  const state = readState();
  return {
    model: (state as any)?.qualifierModel ?? DEFAULT_MODEL,
    baseUrl: (state as any)?.qualifierBaseUrl ?? DEFAULT_BASE_URL,
  };
}

// ─── Prompts ────────────────────────────────────────────────────────────

const DEV_JUDGE_PROMPT = `You are a strict workflow quality gate. Your job is to reject outputs that are not substantive work.

Given a dev's plan phase output, determine if it contains actual work or is essentially empty.

Respond with one word only: PASS or REJECT.

PASS = output contains any of: actual architecture decisions, risk analysis, implementation approach, technical specifications, proposed solutions, research findings, concrete plans.
PASS = output is asking for requirements or clarification (this is expected when context is missing).

REJECT = output is empty, too brief (just a few words like "ok" or "done") to be useful, or repeats the task verbatim without adding any value.`;

const QA_JUDGE_PROMPT = `You are a strict workflow quality gate. Your job is to reject outputs that are not substantive review work.

Given a QA reviewer's output for any phase (plan review, build review, or release confirmation), determine if it contains actual review work or is just a placeholder.

Respond with one word only: PASS or REJECT.

PASS = output contains any of: specific feedback on the work, identified issues, approval reasoning, scoring, detailed analysis, specific concerns, or actionable next steps. Output may include tags like [SUCCESS], [FAILURE], [BLOCKER].

REJECT = output is too brief (just "looks good", "approved" without reasoning), just asks questions without providing review, is clearly a template/placeholder, or doesn't engage with the actual work product.`;

// ─── Judge ──────────────────────────────────────────────────────────────

/**
 * Call the qualifier LLM to judge whether role output is substantive.
 * Returns "pass" or "reject".
 */
export async function judgeOutput(
  role: Role,
  output: string,
): Promise<JudgeResult> {
  // Heuristic pre-check: long output is always substantive enough
  if (output.length > 500) {
    debugLog(`[pworkflow] qualifier: ${role} output >500 chars → PASS (heuristic)`);
    return { verdict: "pass", raw: "heuristic: output >500 chars" };
  }

  // Hard floor: output < 80 chars that isn't asking for requirements is garbage
  if (output.length < 80 && role === "dev") {
    const askPatterns = /\b(please provide|i need|what are the|tell me about|could you|can you|i'm? (in|at) the|give me|i require|i would need|i'm ready when you are)\b/i;
    if (!askPatterns.test(output)) {
      debugLog(`[pworkflow] qualifier: ${role} output <80 chars and not asking → REJECT (hard floor)`);
      return { verdict: "reject", raw: "output too short to be substantive" };
    }
  }

  // Heuristic pre-check for dev: asking for requirements is always PASS
  // (the tiny LLM can't reliably distinguish this vs. actual work)
  if (role === "dev") {
    const askPatterns = /\b(please provide|i need|what are the|tell me about|could you|can you|i'm? (in|at) the|give me|i require|i would need|i'm ready when you are)\b/i;
    if (askPatterns.test(output) && output.length < 800) {
      debugLog("[pworkflow] qualifier: dev asking for requirements → PASS (heuristic)");
      return { verdict: "pass", raw: "heuristic: asking for requirements" };
    }
  }

  const { model, baseUrl } = getQualifierConfig();
  const systemPrompt = role === "dev" ? DEV_JUDGE_PROMPT : QA_JUDGE_PROMPT;

  // Truncate output to prevent token blowup — qualifier only needs first ~1KB
  const truncated = output.slice(0, 1500);

  debugLog(`[pworkflow] qualifier: judging ${role} output (${truncated.length} chars) with ${model}`);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `--- Output to judge ---\n${truncated}\n--- End output ---\n\nRespond PASS or REJECT:` },
        ],
        temperature: 0.1, // low temp for deterministic judgment
        max_tokens: 256, // plenty for think tags + verdict
        stream: false,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      debugLog(`[pworkflow] qualifier: HTTP ${res.status}: ${text}`);
      // On error, pass by default — don't block workflow on qualifier failure
      return { verdict: "pass", raw: "qualifier HTTP error" };
    }

    const json = await res.json();
    const raw = (json?.choices?.[0]?.message?.content || "").trim();
    // Strip think tags (lfm2.5 wraps response in <think>...</think>)
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim().toUpperCase();
    debugLog(`[pworkflow] qualifier: raw="${raw}", cleaned="${cleaned}"`);

    const verdict: QualifierVerdict = cleaned.startsWith("PASS") ? "pass" : cleaned.startsWith("REJECT") ? "reject" : "pass";
    if (!cleaned.startsWith("PASS") && !cleaned.startsWith("REJECT")) {
      debugLog(`[pworkflow] qualifier: unexpected response, defaulting to pass`);
    }
    return { verdict, raw };
  } catch (err) {
    debugLog(`[pworkflow] qualifier: error calling LLM: ${err}`);
    // On error, pass by default
    return { verdict: "pass", raw: "qualifier error" };
  }
}
