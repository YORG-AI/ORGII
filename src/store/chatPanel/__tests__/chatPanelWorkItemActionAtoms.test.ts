import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  consumeChatPanelWorkItemActionAtom,
  pendingChatPanelWorkItemActionAtom,
  requestChatPanelWorkItemActionAtom,
} from "../chatPanelWorkItemActionAtoms";

describe("chat panel Work Item action requests", () => {
  it("consumes a matching start request exactly once", () => {
    const store = createStore();
    const request = store.set(requestChatPanelWorkItemActionAtom, {
      workItemShortId: "ORG-42",
      action: "start_agent",
    });

    expect(store.get(pendingChatPanelWorkItemActionAtom)).toEqual(request);
    expect(store.set(consumeChatPanelWorkItemActionAtom, request)).toEqual(
      request
    );
    expect(store.get(pendingChatPanelWorkItemActionAtom)).toBeNull();
    expect(store.set(consumeChatPanelWorkItemActionAtom, request)).toBeNull();
  });

  it("does not consume a request from another Work Item", () => {
    const store = createStore();
    const request = store.set(requestChatPanelWorkItemActionAtom, {
      workItemShortId: "ORG-42",
      action: "start_agent",
    });

    expect(
      store.set(consumeChatPanelWorkItemActionAtom, {
        ...request,
        workItemShortId: "ORG-43",
      })
    ).toBeNull();
    expect(store.get(pendingChatPanelWorkItemActionAtom)).toEqual(request);
  });

  it("lets the newest unclaimed navigation intent supersede an older one", () => {
    const store = createStore();
    const olderRequest = store.set(requestChatPanelWorkItemActionAtom, {
      workItemShortId: "ORG-42",
      action: "start_agent",
    });
    const newestRequest = store.set(requestChatPanelWorkItemActionAtom, {
      workItemShortId: "ORG-43",
      action: "start_agent",
    });

    expect(store.get(pendingChatPanelWorkItemActionAtom)).toEqual(
      newestRequest
    );
    expect(
      store.set(consumeChatPanelWorkItemActionAtom, olderRequest)
    ).toBeNull();
    expect(
      store.set(consumeChatPanelWorkItemActionAtom, newestRequest)
    ).toEqual(newestRequest);
  });
});
