import { invoke } from "@tauri-apps/api/core";

export async function generateCommitMessage(
  repoPath: string,
  commitInstructions?: string
): Promise<string> {
  const normalizedInstructions = commitInstructions?.trim();
  return invoke<string>("generate_commit_message", {
    repoPath,
    commitInstructions: normalizedInstructions || null,
  });
}
