import assert from "node:assert/strict";
import test from "node:test";

import { CliUsageError, parseCliArgs } from "../lib/args.mjs";

test("record arguments have bounded, explicit defaults", () => {
  assert.deepEqual(parseCliArgs(["memory", "record"]), {
    command: "memory",
    subcommand: "record",
    pid: "auto",
    intervalSeconds: 15,
    maxSamples: 720,
    durationSeconds: undefined,
    outputRoot: undefined,
    stateRoot: undefined,
  });
});

test("record arguments parse lifecycle bounds", () => {
  assert.deepEqual(
    parseCliArgs([
      "memory",
      "record",
      "--pid",
      "42",
      "--interval",
      "2.5",
      "--duration",
      "30",
      "--max-samples",
      "12",
    ]),
    {
      command: "memory",
      subcommand: "record",
      pid: 42,
      intervalSeconds: 2.5,
      maxSamples: 12,
      durationSeconds: 30,
      outputRoot: undefined,
      stateRoot: undefined,
    }
  );
});

test("mark preserves a Unicode label while accepting state root", () => {
  assert.deepEqual(
    parseCliArgs([
      "memory",
      "mark",
      "打开",
      "20",
      "个会话",
      "--state-root",
      "/tmp/state",
    ]),
    {
      command: "memory",
      subcommand: "mark",
      label: "打开 20 个会话",
      stateRoot: "/tmp/state",
    }
  );
});

test("invalid positive values are rejected", () => {
  assert.throws(
    () => parseCliArgs(["memory", "record", "--max-samples", "0"]),
    CliUsageError
  );
});
