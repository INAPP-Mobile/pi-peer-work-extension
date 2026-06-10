import { appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG_FILE = join(process.cwd(), ".pworkflow", "debug.log");

export function debugLog(message: any, ...args: any[]) {
    const timestamp = new Date().toISOString();
    const formattedMessage = typeof message === "object" 
        ? JSON.stringify(message, null, 2) 
        : message;
    
    const logLine = `[${timestamp}] ${formattedMessage}${args.length > 0 ? " " + JSON.stringify(args) : ""}\n`;
    
    try {
        appendFileSync(LOG_FILE, logLine);
    } catch (e) {
        // Fallback to console if writing to file fails
    }
}

let _debugLoggingSetup = false;

export function setupDebugLogging() {
    if (_debugLoggingSetup) return;
    _debugLoggingSetup = true;
    const originalLog = console.log;
    console.log = (...args: any[]) => {
        debugLog(args[0], ...args.slice(1));
        originalLog(...args);
    };
}
