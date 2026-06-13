import {
  appendFileSync,
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { ExtensionContext } from "@earendil-works/pi-coding-agent";

const LOG_FILE = join(process.cwd(), ".pworkflow", "debug.log");
const MAX_LOG_SIZE = 1024 * 1024; // 1MB
const MAX_ARCHIVES = 3; // keep debug.log.1 through debug.log.N

function rotateLog(): void {
  // Shift archives: .3→remove, .2→.3, .1→.2, current→.1
  for (let i = MAX_ARCHIVES; i >= 0; i--) {
    const oldPath = i === 0 ? LOG_FILE : LOG_FILE + "." + i;
    const newPath = LOG_FILE + "." + (i + 1);
    if (existsSync(oldPath)) {
      if (i === MAX_ARCHIVES) {
        // Remove oldest archive
        try {
          unlinkSync(oldPath);
        } catch {}
      } else {
        try {
          renameSync(oldPath, newPath);
        } catch {}
      }
    }
  }
}

export function debugLog(message: any, ...args: any[]) {
  const d = new Date();
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  const tz = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const timestamp =
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds()) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0") +
    tz;
  const formattedMessage =
    typeof message === "object" ? JSON.stringify(message, null, 2) : message;

  const logLine = `[${timestamp}] ${formattedMessage}${args.length > 0 ? " " + JSON.stringify(args) : ""}\n`;

  try {
    if (existsSync(LOG_FILE)) {
      const st = statSync(LOG_FILE);
      if (st.size > MAX_LOG_SIZE) {
        rotateLog();
        // Write to the now-empty debug.log
        appendFileSync(LOG_FILE, logLine);
        return;
      }
    }
    appendFileSync(LOG_FILE, logLine);
  } catch (e) {
    // Fallback to console if writing to file fails
  }
}

let _debugLoggingSetup = false;
const LOG_WRAPPER_KEY = "__pworkflow_wrapped__";

export function setupDebugLogging() {
  if (_debugLoggingSetup) return;
  _debugLoggingSetup = true;
  // Guard against hot-reload chaining: only wrap if not already wrapped
  if ((console.log as any)[LOG_WRAPPER_KEY]) return;

  const originalLog = console.log;
  const wrapped = (...args: any[]) => {
    debugLog(args[0], ...args.slice(1));
    originalLog(...args);
  };
  (wrapped as any)[LOG_WRAPPER_KEY] = true;
  console.log = wrapped;
}
