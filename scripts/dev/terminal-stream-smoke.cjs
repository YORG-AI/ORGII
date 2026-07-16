#!/usr/bin/env node

/**
 * Manual smoke test for ORGII terminal streaming.
 *
 * Run this inside the in-app terminal:
 *   node scripts/dev/terminal-stream-smoke.cjs
 *
 * Each STREAM line should appear exactly once. If any STREAM id appears twice,
 * the terminal has duplicate PTY event listeners or replayed live output.
 */

const readline = require("node:readline");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeLine(id, label) {
  const stamp = new Date().toISOString().slice(11, 23);
  process.stdout.write(`STREAM ${String(id).padStart(3, "0")} ${stamp} ${label}\n`);
}

async function main() {
  process.stdout.write("\nterminal-stream-smoke start\n");
  process.stdout.write("Expected: every STREAM id appears once.\n\n");

  for (let i = 1; i <= 12; i++) {
    writeLine(i, "steady-line");
    await delay(60);
  }

  process.stdout.write("\nansi-status phase\n");
  for (let i = 13; i <= 20; i++) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`STREAM ${String(i).padStart(3, "0")} status-frame`);
    await delay(80);
  }
  process.stdout.write("\n");

  process.stdout.write("\nburst phase\n");
  for (let i = 21; i <= 60; i++) {
    writeLine(i, "burst-line");
  }

  process.stdout.write("\nterminal-stream-smoke done\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
