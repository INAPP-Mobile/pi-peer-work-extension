// ─── Telegram Notification ──────────────────────────────────────────────
//
// Ported from pi-cowork-extension/lib/tools/cowork-telegram.ts
// Reads config from .pworkflow/settings.json or ~/.pi/pworkflow/settings.json

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "";
const PROJECT_SETTINGS = join(process.cwd(), ".pworkflow", "settings.json");
const PI_SETTINGS = join(HOME, ".pi", "pworkflow", "settings.json");

interface Settings {
  telegramBotToken?: string;
  telegramChatId?: string;
}

async function readSettings(): Promise<Settings> {
  for (const path of [PROJECT_SETTINGS, PI_SETTINGS]) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        return JSON.parse(raw) as Settings;
      } catch {}
    }
  }
  return {};
}

/**
 * Send a notification to the configured Telegram chat.
 * Returns { ok, error? }.
 */
export async function notifyTelegram(
  message: string,
  parseMode?: "Markdown" | "HTML",
): Promise<{ ok: boolean; error?: string }> {
  const settings = await readSettings();
  const token = settings.telegramBotToken;
  const chatId = settings.telegramChatId;

  if (!token) {
    return {
      ok: false,
      error:
        "Telegram bot token not configured. " +
        "Set telegramBotToken in .pworkflow/settings.json or ~/.pi/pworkflow/settings.json",
    };
  }

  if (!chatId) {
    return {
      ok: false,
      error:
        "Telegram chat ID not configured. " +
        "Set telegramChatId in .pworkflow/settings.json or ~/.pi/pworkflow/settings.json",
    };
  }

  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: message,
    };
    if (parseMode) body.parse_mode = parseMode;

    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const json = await res.json();

    if (!res.ok || !json.ok) {
      return {
        ok: false,
        error: `Telegram API error (${res.status}): ${json.description || JSON.stringify(json)}`,
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to send Telegram notification: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
