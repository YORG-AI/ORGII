import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import {
  type ConversationRootLocator,
  conversationRootKey,
} from "@src/engines/SessionCore/conversations/conversationTypes";
import { NATIVE_SOURCE_EVENT_ID_ARG } from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isVisibleInChat } from "@src/engines/SessionCore/ingestion/visibilityFilters";
import { buildConversationRunnerOverlay } from "@src/features/Org2Cloud/SessionConversation/conversationRunnerOverlay";
import {
  type ActiveMessageDelivery,
  messageDeliveryRecordsAtom,
} from "@src/store/ui/messageQueueAtom";

import {
  conversationActiveDeliveriesAtom,
  createLocalExecutionHydrationCoordinator,
  projectVisibleLocalExecutionTail,
  resolveConversationRunnerBindings,
  selectConversationActiveRunners,
  shouldHydrateLocalExecutionSnapshot,
} from "./ConversationStreamProvider";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function messageEvent(
  id: string,
  source: "user" | "assistant",
  displayText: string,
  createdAt: string
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "root",
    createdAt,
    functionName: source === "user" ? "user_message" : "assistant_message",
    uiCanonical: source === "user" ? "user" : "assistant_message",
    actionType: source === "user" ? "raw" : "assistant",
    args: {},
    result: { content: displayText },
    source,
    displayText,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
}

function root(conversationId: string): ConversationRootLocator {
  return {
    authority: "org2-cloud",
    authorityScope: ["https://cloud.example", "org-1"],
    conversationId,
  };
}

function activeDelivery(
  id: string,
  conversationId: string,
  dispatchIdentityKey = "identity-a"
): ActiveMessageDelivery {
  return {
    id,
    turnIntentId: `turn-${id}`,
    sessionId: conversationId,
    content: id,
    displayContent: id,
    conversationDispatch: {
      kind: "canonical_conversation",
      root: root(conversationId),
      target: { cliAgentType: "claude_code" },
      dispatchIdentityKey,
    },
    status: "preparing",
    priority: "next",
    createdAt: "2026-09-04T00:00:00.000Z",
  };
}

describe("resolveConversationRunnerBindings", () => {
  it("keeps the visible transcript on its canonical source while footer and Stop follow the runner", () => {
    expect(
      resolveConversationRunnerBindings(
        "codexapp-canonical-source",
        "cliagent-native-runner"
      )
    ).toEqual({
      sourceSessionId: "codexapp-canonical-source",
      controlSessionId: "cliagent-native-runner",
      planningIndicatorScope: {
        sessionId: "cliagent-native-runner",
        isLive: true,
      },
    });
  });

  it("returns footer and Stop to their ordinary source owners without a runner", () => {
    expect(
      resolveConversationRunnerBindings("cliagent-ordinary", null)
    ).toEqual({
      sourceSessionId: "cliagent-ordinary",
      controlSessionId: null,
      planningIndicatorScope: null,
    });
  });
});

describe("conversation delivery lifecycle scoping", () => {
  it("does not notify one conversation when an unrelated delivery changes", () => {
    const store = createStore();
    const matching = activeDelivery("matching", "root-a");
    const unrelated = activeDelivery("unrelated", "root-b");
    const scopedAtom = conversationActiveDeliveriesAtom({
      cloudRootKey: conversationRootKey(root("root-a")),
      cloudIdentityKey: "identity-a",
      localRootKey: null,
    });
    const listener = vi.fn();
    const unsubscribe = store.sub(scopedAtom, listener);

    store.set(messageDeliveryRecordsAtom, [matching]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get(scopedAtom)).toEqual([matching]);

    store.set(messageDeliveryRecordsAtom, [matching, unrelated]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.set(messageDeliveryRecordsAtom, [matching, { ...unrelated }]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.set(messageDeliveryRecordsAtom, [{ ...matching }, unrelated]);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("keeps Cloud delivery identity isolation while local roots use their root owner", () => {
    const matching = activeDelivery("matching", "root-a", "identity-a");
    const wrongIdentity = activeDelivery(
      "wrong-identity",
      "root-a",
      "identity-b"
    );
    const local = activeDelivery("local", "local-root", "identity-b");
    const store = createStore();
    const scopedAtom = conversationActiveDeliveriesAtom({
      cloudRootKey: conversationRootKey(root("root-a")),
      cloudIdentityKey: "identity-a",
      localRootKey: conversationRootKey(root("local-root")),
    });
    store.set(messageDeliveryRecordsAtom, [matching, wrongIdentity, local]);

    expect(store.get(scopedAtom)).toEqual([matching, local]);
  });
});

describe("local execution-child hydration lifecycle", () => {
  it("hydrates only on first/root-change/settled-delivery boundaries", () => {
    expect(
      shouldHydrateLocalExecutionSnapshot(null, {
        rootKey: "root-a",
        activeDeliveryCount: 0,
      })
    ).toBe(true);
    expect(
      shouldHydrateLocalExecutionSnapshot(
        { rootKey: "root-a", activeDeliveryCount: 0 },
        { rootKey: "root-a", activeDeliveryCount: 1 }
      )
    ).toBe(false);
    expect(
      shouldHydrateLocalExecutionSnapshot(
        { rootKey: "root-a", activeDeliveryCount: 1 },
        { rootKey: "root-a", activeDeliveryCount: 0 }
      )
    ).toBe(true);
    expect(
      shouldHydrateLocalExecutionSnapshot(
        { rootKey: "root-a", activeDeliveryCount: 0 },
        { rootKey: "root-b", activeDeliveryCount: 0 }
      )
    ).toBe(true);
    expect(
      shouldHydrateLocalExecutionSnapshot(
        { rootKey: "root-a", activeDeliveryCount: 0 },
        { rootKey: null, activeDeliveryCount: 0 }
      )
    ).toBe(false);
  });

  it("single-flights hydration bursts and commits only the latest generation", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const loads: string[] = [];
    const commits: Array<[string, string]> = [];
    const coordinator = createLocalExecutionHydrationCoordinator(
      async (request: string) => {
        loads.push(request);
        return loads.length === 1 ? first.promise : second.promise;
      },
      (result, request) => commits.push([result, request]),
      () => undefined
    );

    coordinator.request("old-root");
    coordinator.request("latest-root");
    expect(loads).toEqual(["old-root"]);

    first.resolve("stale-result");
    await first.promise;
    await vi.waitFor(() => {
      expect(loads).toEqual(["old-root", "latest-root"]);
    });
    expect(commits).toEqual([]);

    second.resolve("latest-result");
    await second.promise;
    await vi.waitFor(() => {
      expect(commits).toEqual([["latest-result", "latest-root"]]);
    });
  });

  it("routes a local active turn through the same runner overlay as Cloud", () => {
    const delivery = {
      ...activeDelivery("local-turn", "local-root"),
      runnerSessionId: "claude-child",
      // Raw provider history contains many rows hidden from chat projection.
      runnerEventStartIndex: 36,
    };
    const [runner] = selectConversationActiveRunners([delivery], {
      cloudRootKey: null,
      cloudIdentityKey: null,
      localRootKey: conversationRootKey(root("local-root")),
      landedTurnIds: new Set(),
    });
    const historical = messageEvent(
      "historical",
      "assistant",
      "old answer",
      "2026-09-05T00:00:00Z"
    );
    const currentUser = messageEvent(
      "current-user",
      "user",
      "continue",
      "2026-09-05T00:01:00Z"
    );
    const currentAssistant = messageEvent(
      "current-assistant",
      "assistant",
      "working",
      "2026-09-05T00:01:01Z"
    );

    expect(runner).toEqual({
      runnerSessionId: "claude-child",
      turnId: "turn-local-turn",
      eventStartIndex: 36,
    });
    if (!runner) throw new Error("expected local active runner");
    expect(
      buildConversationRunnerOverlay(
        runner,
        [
          historical,
          {
            ...currentUser,
            result: {
              ...currentUser.result,
              turnIntentId: "turn-local-turn",
            },
          },
          {
            ...historical,
            id: "materialized-historical",
            chunk_id: "materialized-historical",
            args: { [NATIVE_SOURCE_EVENT_ID_ARG]: historical.id },
          },
          currentAssistant,
        ],
        "local-root",
        [historical]
      ).map((event) => [event.id, event.displayText])
    ).toEqual([["runlive-current-assistant", "working"]]);
  });

  it("verifies a child against raw native history before applying chat visibility", () => {
    const rawRoot = [
      messageEvent("root-user", "user", "inspect", "2026-09-05T00:00:00Z"),
      // Normal chat projection hides this structural native message, but it
      // still participates in the provider transcript prefix.
      messageEvent("root-hidden", "assistant", "   ", "2026-09-05T00:00:01Z"),
      messageEvent("root-answer", "assistant", "done", "2026-09-05T00:00:02Z"),
    ];
    const suffix = [
      messageEvent("child-user", "user", "continue", "2026-09-05T00:01:00Z"),
      messageEvent(
        "child-answer",
        "assistant",
        "continued",
        "2026-09-05T00:01:01Z"
      ),
    ];
    const childEvents = [
      ...rawRoot.map((event) => ({
        ...event,
        id: `child-${event.id}`,
        chunk_id: `child-${event.id}`,
      })),
      ...suffix,
    ];
    const child = {
      session_id: "claude-child",
      created_at: "2026-09-05T00:01:00Z",
    };

    expect(rawRoot.filter(isVisibleInChat)).toHaveLength(2);
    expect(
      projectVisibleLocalExecutionTail(
        rawRoot.filter(isVisibleInChat),
        [{ child, events: childEvents }],
        "root"
      )
    ).toEqual([]);
    expect(
      projectVisibleLocalExecutionTail(
        rawRoot,
        [{ child, events: childEvents }],
        "root"
      ).map((event) => event.displayText)
    ).toEqual(["continue", "continued"]);
  });
});
