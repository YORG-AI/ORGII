import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  conversationTargetOverridesAtom,
  reconcileConversationTargetOverrideAtom,
  setConversationTargetOverrideAtom,
} from "../conversationTargetAtom";

describe("conversation target override lifecycle", () => {
  it("rejects incomplete cross-runtime targets at the persistence boundary", () => {
    const store = createStore();
    store.set(setConversationTargetOverrideAtom, {
      rootKey: "root-1",
      target: {
        cliAgentType: "codex",
        workspaceRepoPath: "/repo",
      },
    });
    expect(store.get(conversationTargetOverridesAtom).has("root-1")).toBe(
      false
    );
  });

  it("clears a draft only after the same target is persisted", () => {
    const store = createStore();
    const target = {
      cliAgentType: "codex",
      accountId: "openai-1",
      model: "gpt-5.6-sol",
      workspaceRepoPath: "/repo",
    } as const;
    store.set(setConversationTargetOverrideAtom, {
      rootKey: "root-1",
      target,
    });

    store.set(reconcileConversationTargetOverrideAtom, {
      rootKey: "root-1",
      persistedTarget: { ...target, model: "gpt-5.5" },
    });
    expect(store.get(conversationTargetOverridesAtom).get("root-1")).toEqual(
      target
    );

    store.set(reconcileConversationTargetOverrideAtom, {
      rootKey: "root-1",
      persistedTarget: target,
    });
    expect(store.get(conversationTargetOverridesAtom).has("root-1")).toBe(
      false
    );
  });
});
