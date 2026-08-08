/**
 * Model preselection for the fork-and-continue setup dialog.
 *
 * Priority question: when the fork's execution agent was NOT explicitly
 * pinned (no user choice, no source agent hint — the local external-history
 * case), should the fallback agent's configured model or the imported
 * session's own model win? The session's model: the user is continuing that
 * conversation, so "the right model" is the one it actually ran on,
 * whenever the selected account offers it. An explicit agent choice (user
 * pick or a collab-fork agent hint) keeps its own configured model first —
 * choosing an agent IS choosing its setup.
 */
export interface ForkModelPreselectionInput {
  /** Model the user explicitly picked in the dialog ("" = none). */
  chosenModel: string;
  /** True when the agent came from a user pick or a source agent hint. */
  agentChoiceExplicit: boolean;
  /** The selected agent's configured model, if the account offers it. */
  preferredAgentModel?: string;
  /** The source session's model, if the selected account offers it. */
  sourceModelOnAccount?: string;
  /** First selectable model of the account (last resort). */
  fallbackModel: string;
}

export function resolveForkModelPreselection({
  chosenModel,
  agentChoiceExplicit,
  preferredAgentModel,
  sourceModelOnAccount,
  fallbackModel,
}: ForkModelPreselectionInput): string {
  return (
    chosenModel ||
    (agentChoiceExplicit ? preferredAgentModel : undefined) ||
    sourceModelOnAccount ||
    preferredAgentModel ||
    fallbackModel
  );
}
