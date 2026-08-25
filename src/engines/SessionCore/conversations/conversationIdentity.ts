/**
 * Provider-neutral identity for a conversation and one local executor.
 *
 * The core deliberately treats authority/scope components as opaque strings.
 * Cloud, imported-history, file-import, and ordinary local-session adapters
 * decide what makes a source unique; Work Items and transport cursors are not
 * part of execution identity.
 */

const ROOT_KEY_TAG = "org2-conversation-root" as const;
const EXECUTOR_SCOPE_TAG = "org2-conversation-executor" as const;
const SETUP_KEY_TAG = "org2-conversation-setup" as const;
const KEY_VERSION = 1 as const;

export type ConversationRootKey = string & {
  readonly __conversationRootKey: unique symbol;
};

export type ConversationExecutorScopeKey = string & {
  readonly __conversationExecutorScopeKey: unique symbol;
};

export interface ConversationRootLocator {
  /** Adapter-owned namespace, for example `local-session` or `org2-cloud`. */
  authority: string;
  /** Stable authority partition; never include credentials or display labels. */
  authorityScope: readonly string[];
  /** Source-side root identity inside that authority partition. */
  conversationId: string;
}

export interface ConversationExecutorLocator {
  /** Runtime host/identity namespace. The local SQLite DB is already per device. */
  authority: string;
  /** Stable principal/partition components; never include API keys or tokens. */
  authorityScope: readonly string[];
}

export interface ConversationExecutionIdentity {
  rootKey: ConversationRootKey;
  executorScopeKey: ConversationExecutorScopeKey;
  executionKey: string;
  setupMemoryKey: string;
}

function requireKeyPart(label: string, value: string): string {
  if (value.length === 0) {
    throw new Error(`conversation ${label} is required`);
  }
  if (value.length > 2_048) {
    throw new Error(`conversation ${label} is too long`);
  }
  return value;
}

function requireScope(label: string, values: readonly string[]): string[] {
  if (values.length > 16) {
    throw new Error(`conversation ${label} has too many parts`);
  }
  return values.map((value, index) =>
    requireKeyPart(`${label}[${index}]`, value)
  );
}

/** Stable root key shared by every trigger and execution episode. */
export function conversationRootKey(
  locator: ConversationRootLocator
): ConversationRootKey {
  return JSON.stringify([
    ROOT_KEY_TAG,
    KEY_VERSION,
    requireKeyPart("root authority", locator.authority),
    requireScope("root authority scope", locator.authorityScope),
    requireKeyPart("root id", locator.conversationId),
  ]) as ConversationRootKey;
}

/** Local executor partition. Runtime/model/workspace belong to an episode. */
export function conversationExecutorScopeKey(
  locator: ConversationExecutorLocator
): ConversationExecutorScopeKey {
  return JSON.stringify([
    EXECUTOR_SCOPE_TAG,
    KEY_VERSION,
    requireKeyPart("executor authority", locator.authority),
    requireScope("executor authority scope", locator.authorityScope),
  ]) as ConversationExecutorScopeKey;
}

/** Durable local execution row key: one executor, one canonical root. */
export function conversationExecutionKey(
  executorScope: string,
  rootKey: string
): string {
  return JSON.stringify([
    requireKeyPart("executor scope", executorScope),
    requireKeyPart("root key", rootKey),
  ]);
}

/** Runtime-selection memory is an adapter-independent view preference. */
export function conversationSetupMemoryKey(input: {
  executorScope: string;
  rootKey: string;
  agentDefinitionId?: string;
}): string {
  return JSON.stringify([
    SETUP_KEY_TAG,
    KEY_VERSION,
    requireKeyPart("executor scope", input.executorScope),
    requireKeyPart("root key", input.rootKey),
    input.agentDefinitionId
      ? requireKeyPart("agent definition", input.agentDefinitionId)
      : "unassigned",
  ]);
}

/** Resolve the complete persistence tuple once at an entry-surface boundary. */
export function resolveConversationExecutionIdentity(input: {
  root: ConversationRootLocator;
  executor: ConversationExecutorLocator;
  agentDefinitionId?: string;
}): ConversationExecutionIdentity {
  const rootKey = conversationRootKey(input.root);
  const executorScopeKey = conversationExecutorScopeKey(input.executor);
  return {
    rootKey,
    executorScopeKey,
    executionKey: conversationExecutionKey(executorScopeKey, rootKey),
    setupMemoryKey: conversationSetupMemoryKey({
      executorScope: executorScopeKey,
      rootKey,
      agentDefinitionId: input.agentDefinitionId,
    }),
  };
}

/**
 * Manual external-history imports need no Work Item, Cloud account, or remote
 * transport. The imported cache/session id is the source-owned identity; an
 * adapter may add a stable source-home/database scope when one provider can
 * expose the same id from more than one authority.
 */
export function resolveImportedConversationExecutionIdentity(input: {
  sourceKind: string;
  sourceSessionId: string;
  sourceAuthorityScope?: readonly string[];
  agentDefinitionId?: string;
}): ConversationExecutionIdentity {
  return resolveConversationExecutionIdentity({
    root: {
      authority: "external-history",
      authorityScope: [
        requireKeyPart("imported source kind", input.sourceKind),
        ...(input.sourceAuthorityScope ?? []),
      ],
      conversationId: input.sourceSessionId,
    },
    executor: {
      authority: "local-device",
      authorityScope: [],
    },
    agentDefinitionId: input.agentDefinitionId,
  });
}

/** Existing writable local sessions are roots/episodes under the same model. */
export function resolveLocalSessionExecutionIdentity(input: {
  sessionId: string;
  agentDefinitionId?: string;
}): ConversationExecutionIdentity {
  return resolveConversationExecutionIdentity({
    root: {
      authority: "local-session",
      authorityScope: [],
      conversationId: input.sessionId,
    },
    executor: {
      authority: "local-device",
      authorityScope: [],
    },
    agentDefinitionId: input.agentDefinitionId,
  });
}
