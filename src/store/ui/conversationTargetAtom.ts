import { atom } from "jotai";

import {
  type LocalConversationTarget,
  isLocalConversationTarget,
} from "@src/engines/SessionCore/conversations/conversationTypes";

const MAX_CONVERSATION_TARGET_OVERRIDES = 32;

/** Unsaved picker choices, keyed by canonical root until an episode persists. */
export const conversationTargetOverridesAtom = atom<
  ReadonlyMap<string, LocalConversationTarget>
>(new Map());
conversationTargetOverridesAtom.debugLabel = "conversationTargetOverridesAtom";

export const setConversationTargetOverrideAtom = atom(
  null,
  (get, set, update: { rootKey: string; target: LocalConversationTarget }) => {
    if (!isLocalConversationTarget(update.target)) return;
    const current = get(conversationTargetOverridesAtom);
    const next = new Map(current);
    next.delete(update.rootKey);
    next.set(update.rootKey, update.target);
    while (next.size > MAX_CONVERSATION_TARGET_OVERRIDES) {
      const oldest = next.keys().next().value as string | undefined;
      if (!oldest) break;
      next.delete(oldest);
    }
    set(conversationTargetOverridesAtom, next);
  }
);

function sameConversationTarget(
  left: LocalConversationTarget,
  right: LocalConversationTarget
): boolean {
  return (
    left.cliAgentType === right.cliAgentType &&
    left.agentDefinitionId === right.agentDefinitionId &&
    left.accountId === right.accountId &&
    left.model === right.model &&
    (left.workspaceRepoPath ?? null) === (right.workspaceRepoPath ?? null)
  );
}

/** Drop a picker draft only after the same target is durable on an episode. */
export const reconcileConversationTargetOverrideAtom = atom(
  null,
  (
    get,
    set,
    update: {
      rootKey: string;
      persistedTarget: LocalConversationTarget | null;
    }
  ) => {
    if (!update.persistedTarget) return;
    const current = get(conversationTargetOverridesAtom);
    const draft = current.get(update.rootKey);
    if (!draft || !sameConversationTarget(draft, update.persistedTarget)) {
      return;
    }
    const next = new Map(current);
    next.delete(update.rootKey);
    set(conversationTargetOverridesAtom, next);
  }
);
