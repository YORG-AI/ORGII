/**
 * GitHub API client core
 *
 * Shared Tauri `invoke` wrapper used by the other `github/*` modules.
 * Credentials are resolved inside the Rust commands from
 * `connection_token_store` — the frontend never passes user IDs or
 * hosted-service tokens.
 */
import { invoke } from "@tauri-apps/api/core";

/**
 * Thrown when the active Git connection is missing or rejected (401) and
 * the user must re-authorize via the Connections wizard.
 */
export class GitHubReAuthError extends Error {
  constructor() {
    super("GitHub re-authorization required");
    this.name = "GitHubReAuthError";
  }
}

export async function invokeWithAuth<T>(
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err: unknown) {
    const msg = String(err);
    if (msg.includes("GitHubReAuthRequired")) {
      throw new GitHubReAuthError();
    }
    throw err;
  }
}
