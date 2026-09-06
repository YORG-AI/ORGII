/** Provider/runtime selection for one writable canonical-conversation episode. */
export interface ConversationRootLocator {
  /** Adapter-owned namespace: local-session, imported-history, or org2-cloud. */
  authority: string;
  /** Stable non-secret partition components. */
  authorityScope: readonly string[];
  conversationId: string;
}

export const NATIVE_CONVERSATION_CLI_TARGETS = [
  "claude_code",
  "codex",
] as const;

export type NativeConversationCliTarget =
  (typeof NATIVE_CONVERSATION_CLI_TARGETS)[number];

export type LocalConversationTarget =
  | {
      agentDefinitionId: string;
      cliAgentType?: never;
      accountId: string;
      model: string;
      workspaceRepoPath?: string | null;
    }
  | {
      /** The external provider owns identity for provider-native execution. */
      agentDefinitionId?: never;
      cliAgentType: string;
      /** Undefined means the provider's ambient local CLI profile. */
      accountId?: string;
      model?: string;
      workspaceRepoPath?: string | null;
    };

/** Fail closed when restoring a durable queue row from disk. */
export function isLocalConversationTarget(
  value: unknown
): value is LocalConversationTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  const workspaceValid =
    target.workspaceRepoPath === undefined ||
    target.workspaceRepoPath === null ||
    typeof target.workspaceRepoPath === "string";
  if (!workspaceValid) return false;
  if (typeof target.agentDefinitionId === "string") {
    return (
      target.agentDefinitionId.length > 0 &&
      target.cliAgentType === undefined &&
      typeof target.accountId === "string" &&
      target.accountId.length > 0 &&
      typeof target.model === "string" &&
      target.model.length > 0
    );
  }
  const cliAgentType = target.cliAgentType as NativeConversationCliTarget;
  const hasAccount =
    typeof target.accountId === "string" && target.accountId.trim().length > 0;
  const hasModel =
    typeof target.model === "string" && target.model.trim().length > 0;
  return (
    target.agentDefinitionId === undefined &&
    typeof target.cliAgentType === "string" &&
    NATIVE_CONVERSATION_CLI_TARGETS.includes(cliAgentType) &&
    ((hasAccount && hasModel) ||
      (cliAgentType === "claude_code" &&
        target.accountId === undefined &&
        (target.model === undefined || hasModel)))
  );
}

export function isConversationRootLocator(
  value: unknown
): value is ConversationRootLocator {
  if (!value || typeof value !== "object") return false;
  const root = value as Record<string, unknown>;
  return (
    typeof root.authority === "string" &&
    root.authority === root.authority.trim() &&
    root.authority.length > 0 &&
    root.authority.length <= 2_048 &&
    Array.isArray(root.authorityScope) &&
    root.authorityScope.length <= 16 &&
    root.authorityScope.every(
      (part) =>
        typeof part === "string" &&
        part === part.trim() &&
        part.length > 0 &&
        part.length <= 2_048
    ) &&
    typeof root.conversationId === "string" &&
    root.conversationId === root.conversationId.trim() &&
    root.conversationId.length > 0 &&
    root.conversationId.length <= 2_048
  );
}

/** Stable key for queue scoping and target-memory lookup. */
export function conversationRootKey(root: ConversationRootLocator): string {
  return JSON.stringify([
    root.authority,
    [...root.authorityScope],
    root.conversationId,
  ]);
}

/** Provider-neutral source metadata for one canonical conversation. */
export interface ConversationSource {
  root: ConversationRootLocator;
  cliAgentType?: string;
  agentDefinitionId?: string;
  agentDisplayName?: string;
  model?: string;
  initialTarget: LocalConversationTarget | null;
  workspaceRepoPath: string | null;
}
