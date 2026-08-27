/**
 * Browser Mode Message
 * ASCII art banner displayed when terminal runs without Tauri
 */
import type { Terminal } from "@xterm/xterm";

/**
 * Display browser mode message in terminal
 * Shows when Tauri desktop app is not available
 */
export function writeBrowserModeMessage(terminal: Terminal): void {
  const lines = [
    "\x1b[36m╔══════════════════════════════════════════════════════════╗\x1b[0m",
    "\x1b[36m║\x1b[0m          \x1b[1;33m⚡ Terminal\x1b[0m                                    \x1b[36m║\x1b[0m",
    "\x1b[36m╠══════════════════════════════════════════════════════════╣\x1b[0m",
    "\x1b[36m║\x1b[0m                                                          \x1b[36m║\x1b[0m",
    "\x1b[36m║\x1b[0m  \x1b[33m⚠\x1b[0m  Running in \x1b[1;35mBrowser Mode\x1b[0m                            \x1b[36m║\x1b[0m",
    "\x1b[36m║\x1b[0m                                                          \x1b[36m║\x1b[0m",
    "\x1b[36m║\x1b[0m  The terminal requires the Tauri desktop app.           \x1b[36m║\x1b[0m",
    "\x1b[36m║\x1b[0m  Please run the application using:                      \x1b[36m║\x1b[0m",
    "\x1b[36m║\x1b[0m                                                          \x1b[36m║\x1b[0m",
    "\x1b[36m║\x1b[0m    \x1b[32m$ pnpm run tauri:dev\x1b[0m                                  \x1b[36m║\x1b[0m",
    "\x1b[36m║\x1b[0m                                                          \x1b[36m║\x1b[0m",
    "\x1b[36m╚══════════════════════════════════════════════════════════╝\x1b[0m",
  ];
  lines.forEach((line) => terminal.writeln(line));
}
