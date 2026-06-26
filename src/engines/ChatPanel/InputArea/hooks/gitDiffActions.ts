/**
 * gitDiffActions
 *
 * Pure (React-free) logic backing `useGitDiffActions`. Kept separate so the
 * orchestration — re-entrancy guard, busy/no-session skipping, and the
 * agent-prompt dispatch sequence — is unit-testable without rendering hooks.
 */

const SYSTEM_GENERATED_GIT_ACTION_LANGUAGE_INSTRUCTION = `

Language:
- This is a system-generated Git action request.
- Continue using the user's language from earlier conversation rounds.
- Do not switch languages just because this generated request is written in English.`;

const SYSTEM_GENERATED_GIT_ACTION_CONFIRMATION_INSTRUCTION = `

Confirmation:
- Do not ask for confirmation for ordinary safe Git steps needed to complete this action.
- Ask the user first only for high-risk or irreversible operations.`;

/** Prompt sent to the agent for a plain "commit" action. */
export const GIT_DIFF_COMMIT_PROMPT = `This is a system-generated Git action request.

Action: Commit the relevant current changes.
Scope:
- Unless the user specifies otherwise, include only the files you have worked on.

Constraints:
- Do not include or modify unnecessary files.
- Inspect the working tree before committing.
- Use the repository's commit message style.
- Do not push to remote.${SYSTEM_GENERATED_GIT_ACTION_CONFIRMATION_INSTRUCTION}${SYSTEM_GENERATED_GIT_ACTION_LANGUAGE_INSTRUCTION}`;

/** Prompt sent to the agent for a "commit & push" action. */
export const GIT_DIFF_COMMIT_PUSH_PROMPT = `This is a system-generated Git action request.

Action: Commit the relevant current changes, then push the current branch to remote.
Scope:
- Unless the user specifies otherwise, include only the files you have worked on.

Constraints:
- Do not include or modify unnecessary files.
- Inspect the working tree before committing.
- Use the repository's commit message style.
- Push only after the commit succeeds.${SYSTEM_GENERATED_GIT_ACTION_CONFIRMATION_INSTRUCTION}${SYSTEM_GENERATED_GIT_ACTION_LANGUAGE_INSTRUCTION}`;

/** Prompt sent to the agent for a plain "push" action. */
export const GIT_DIFF_PUSH_PROMPT = `This is a system-generated Git action request.

Action: Push the current branch to remote.
Scope:
- Push the existing local commits on the current branch.

Constraints:
- Do not stage files.
- Do not unstage files.
- Do not edit files.
- Do not create new commits.
- Do not amend commits.
- Push only the current branch.${SYSTEM_GENERATED_GIT_ACTION_CONFIRMATION_INSTRUCTION}${SYSTEM_GENERATED_GIT_ACTION_LANGUAGE_INSTRUCTION}`;

/** Prompt sent to the agent for a "create PR" action. */
export const GIT_DIFF_CREATE_PR_PROMPT = `This is a system-generated Git action request.

Action: Create a pull request for the current branch.
Scope:
- Unless the user specifies otherwise, include only the files you have worked on.

Constraints:
- Inspect the current branch, remote tracking state, and commits ahead of the base branch.
- Do not include or modify unnecessary files.
- Do not stage files, unstage files, edit files, or create new commits unless the user explicitly requested it.
- If the branch has existing local commits that need to be pushed before creating the PR, push those existing commits only.
- Use the repository's PR title and description style.${SYSTEM_GENERATED_GIT_ACTION_CONFIRMATION_INSTRUCTION}${SYSTEM_GENERATED_GIT_ACTION_LANGUAGE_INSTRUCTION}`;

/** A mutable single-slot guard, structurally compatible with a React ref. */
export interface MutableGuard {
  current: boolean;
}

/**
 * The agent-driven git actions (commit / commit & push / push) require an
 * idle session to run, so they are disabled while a turn is in flight or when
 * there is no session.
 */
export function computeGitActionsDisabled(opts: {
  isSessionActive: boolean;
  sessionId?: string | null;
}): boolean {
  return opts.isSessionActive || !opts.sessionId;
}

export interface RunAgentGitActionDeps {
  sessionId?: string | null;
  isSessionActive: boolean;
  /** Re-entrancy guard shared across invocations (a React ref in the hook). */
  guard: MutableGuard;
  prompt: string;
  submitPrompt: (sessionId: string, prompt: string) => Promise<void>;
  onError?: (err: unknown) => void;
}

/**
 * Sends an agent prompt that performs a git action.
 *
 * Returns `true` when the prompt was dispatched, `false` when skipped
 * (no session, session busy, or a prior action still pending).
 */
export async function runAgentGitAction(
  deps: RunAgentGitActionDeps
): Promise<boolean> {
  const { sessionId, isSessionActive, guard, prompt } = deps;
  if (!sessionId || isSessionActive || guard.current) return false;

  guard.current = true;
  try {
    await deps.submitPrompt(sessionId, prompt);
    return true;
  } catch (err) {
    deps.onError?.(err);
    return false;
  } finally {
    guard.current = false;
  }
}
