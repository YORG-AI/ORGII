/**
 * Prerequisite binary detection for install methods.
 *
 * Maps install method IDs (from the backend) and package manager
 * names to the binary they require on the user's system.
 * Also provides a helper to derive the required binary from an installHint
 * string (used by LSP / Lint where no method ID is available).
 */

/**
 * Install method ID → required binary on PATH.
 * Methods not listed here (curl, powershell, native, manual, etc.)
 * are assumed to be always available or platform-native.
 */
export const INSTALL_METHOD_PREREQUISITES: Record<string, string> = {
  npm: "npm",
  npx: "npx",
  homebrew: "brew",
  pip: "pip",
  pipx: "pipx",
  cargo: "cargo",
  uv: "uv",
  snap: "snap",
  scoop: "scoop",
  winget: "winget",
};
