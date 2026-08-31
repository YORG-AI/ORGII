/**
 * Command card parser — summarises shell tool results for build, install and
 * git style commands.
 */
import type { CommandArtifact, CommandResultData } from "../../types";

const BUILD_SUCCESS_RE =
  /(?:build|compiled|bundled|built)\s+(?:succeeded?|successfully|completed?)/i;
const BUILD_ARTIFACTS_RE =
  /^\s*(dist\/\S+|\S+\.(js|ts|css|wasm|json|html))\s+([\d.,]+\s*[kmg]?b)/gim;
const NPM_INSTALL_RE = /added\s+(\d+)\s+packages?/i;
const CARGO_BUILD_RE = /Finished\s+\S+\s+\[.*?\]\s+target/i;
const GIT_RE = /^(commit [0-9a-f]{7,}|Merge|Fast-forward|Already up to date)/im;

export function parseCommandResult(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): CommandResultData | null {
  const command =
    (typeof args.command === "string" ? args.command : null) ??
    (typeof args.cmd === "string" ? args.cmd : null);
  if (!command) return null;

  const rawExitCode = result.exit_code ?? result.exitCode ?? result.code;
  const exitCode =
    typeof rawExitCode === "number"
      ? rawExitCode
      : result.success === true
        ? 0
        : -1;

  const stdout =
    (typeof result.stdout === "string" ? result.stdout : null) ??
    (typeof result.output === "string" ? result.output : null) ??
    (typeof result.content === "string" ? result.content : null) ??
    "";

  if (!stdout && exitCode < 0) return null;

  let summary = "";
  const artifacts: CommandArtifact[] = [];

  if (BUILD_SUCCESS_RE.test(stdout)) {
    summary = "Build succeeded";
    let match;
    const re = new RegExp(BUILD_ARTIFACTS_RE.source, "gim");
    while ((match = re.exec(stdout)) !== null) {
      artifacts.push({ label: match[1].trim(), value: match[3].trim() });
      if (artifacts.length >= 6) break;
    }
  } else if (NPM_INSTALL_RE.test(stdout)) {
    const pkgMatch = stdout.match(NPM_INSTALL_RE);
    summary = pkgMatch ? `Installed ${pkgMatch[1]} packages` : "npm install";
  } else if (CARGO_BUILD_RE.test(stdout)) {
    summary = exitCode === 0 ? "Cargo build succeeded" : "Cargo build failed";
  } else if (GIT_RE.test(stdout)) {
    const firstLine = stdout.trim().split("\n")[0];
    summary = firstLine.substring(0, 80);
  } else {
    return null;
  }

  return { command, exitCode, summary, artifacts };
}
