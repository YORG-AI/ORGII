import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const e2eRoot = resolve(__dirname, "..");

const specs = [
  "./specs/core/agent-settings/custom-config-ui.spec.mjs",
  "./specs/core/agent-settings/lifecycle-wizard-ui.spec.mjs",
  "./specs/core/agent-settings/security-policy-ui.spec.mjs",
  "./specs/core/agent-settings/management-entry-ui.spec.mjs",
  "./specs/core/agent-settings/org-detail-ui.spec.mjs",
];

for (const spec of specs) {
  console.log(`\n[agent-settings:e2e] Running ${spec}`);
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wdio", "run", "./wdio.conf.mjs", "--spec", spec],
    {
      cwd: e2eRoot,
      env: process.env,
      stdio: "inherit",
    }
  );

  if (result.error) {
    console.error(`[agent-settings:e2e] Failed to launch ${spec}`);
    console.error(result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(
      `[agent-settings:e2e] ${spec} failed with exit code ${result.status}`
    );
    process.exit(result.status ?? 1);
  }
}

console.log(
  "\n[agent-settings:e2e] All Agent Settings specs passed sequentially."
);
