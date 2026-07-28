#!/usr/bin/env node

const command = process.argv[2];

if (!command || command === "help" || command === "--help") {
  process.stdout.write("orgtrack commands: scan, sync, repair, stats\n");
  process.exit(0);
}

if (!["scan", "sync", "repair", "stats"].includes(command)) {
  console.error(`Unknown orgtrack command: ${command}`);
  process.exit(1);
}

process.stdout.write(
  `orgtrack ${command} is a thin package entrypoint. Native orgtrack-core bindings will be attached during publish prep.\n`
);
