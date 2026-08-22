import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  acquireTypecheckLock,
  createTypecheckFingerprint,
  isSuccessfulTypecheckCached,
  repoRoot,
  writeSuccessfulTypecheck,
} from "./verification-policy.mjs";

function runFinalVerification() {
  const force = process.argv.includes("--force");
  const isCi = Boolean(process.env.CI && process.env.CI !== "false");
  const useLocalCache = !isCi && !force;
  const fingerprintBefore = useLocalCache ? createTypecheckFingerprint() : null;

  if (fingerprintBefore && isSuccessfulTypecheckCached(fingerprintBefore)) {
    process.stdout.write(
      "Full TypeScript check skipped: this exact code state already passed.\n"
    );
    return 0;
  }

  const releaseLock = useLocalCache ? acquireTypecheckLock() : () => {};
  if (useLocalCache && !releaseLock) {
    process.stderr.write(
      "A full TypeScript check is already running in this workspace; duplicate run blocked.\n"
    );
    return 2;
  }

  try {
    if (fingerprintBefore && isSuccessfulTypecheckCached(fingerprintBefore)) {
      process.stdout.write(
        "Full TypeScript check skipped: another process already verified this code state.\n"
      );
      return 0;
    }

    process.stdout.write(
      isCi
        ? "Running full TypeScript check (CI cache bypassed)...\n"
        : force
          ? "Running full TypeScript check (--force)...\n"
          : "Running final full TypeScript check...\n"
    );

    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const result = spawnSync(
      pnpm,
      ["exec", "tsc", "--noEmit", "--pretty", "false"],
      { cwd: repoRoot, stdio: "inherit" }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;

    if (fingerprintBefore) {
      const fingerprintAfter = createTypecheckFingerprint();
      if (fingerprintAfter !== fingerprintBefore) {
        process.stderr.write(
          "Code changed while TypeScript was running; result was not cached. Run the final check again after edits stop.\n"
        );
        return 2;
      }
      writeSuccessfulTypecheck(fingerprintAfter);
    }

    return 0;
  } finally {
    releaseLock?.();
  }
}

process.exitCode = runFinalVerification();
