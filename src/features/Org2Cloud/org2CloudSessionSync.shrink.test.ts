import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";

import type { CloudPushAccess } from "./org2CloudAccessSettings";
import { Org2CloudSessionSync } from "./org2CloudSessionSync";
import type { Org2CloudSyncClientDeps } from "./org2CloudSessionSync.types";
import { AUTH, SCOPE_KEY, SESSION } from "./org2CloudSyncEngine.testUtils";

const ORG_ID = "corg-1";

const ACCESS: CloudPushAccess = {
  accessMode: COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
  visibility: "org",
};

function makeClient() {
  return {
    upsertSessionMetadata: vi.fn(async () => {}),
    appendSessionEvents: vi.fn(async () => {}),
    rewriteSessionEvents: vi.fn(async () => {}),
    getSessionEvents: vi.fn(async () => ({ events: [], epoch: 0 })),
    getOrgRepoScopes: vi.fn(async () => ({ repoScopes: [] })),
    listOrgSessions: vi.fn(async () => ({ sessions: [] })),
    deleteSession: vi.fn(async () => {}),
  } as unknown as Org2CloudSyncClientDeps & {
    rewriteSessionEvents: ReturnType<typeof vi.fn>;
    appendSessionEvents: ReturnType<typeof vi.fn>;
  };
}

function pushEvent(index: number): SessionEvent {
  return {
    id: `event-${index}`,
    chunk_id: `event-${index}`,
    sessionId: SESSION.session_id,
    createdAt: new Date(1700000000000 + index * 1000).toISOString(),
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: { type: "user", message: { content: `m${index}`, role: "user" } },
    source: "user",
    displayText: `m${index}`,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  } as unknown as SessionEvent;
}

async function pushPass(
  sync: Org2CloudSessionSync,
  events: SessionEvent[]
): Promise<void> {
  sync.beginPass();
  sync.noteSessionEventActivity(SESSION.session_id);
  vi.spyOn(
    sync as unknown as {
      loadFullPushEvents: (
        sessionId: string
      ) => Promise<{ events: SessionEvent[] }>;
    },
    "loadFullPushEvents"
  ).mockResolvedValueOnce({ events });
  await sync.pushSession(AUTH, ORG_ID, SESSION, SCOPE_KEY, ACCESS);
}

describe("Org2CloudSessionSync shrink guard", () => {
  it("never rewrites the cloud copy from a hollow local read, even across passes", async () => {
    const client = makeClient();
    const store = createStore();
    const sync = new Org2CloudSessionSync(() => store, client);

    await pushPass(sync, [pushEvent(1), pushEvent(2), pushEvent(3)]);
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);

    // The old consecutive-pass confirmation treated the second identical
    // hollow read as intent and erased the cloud copy. An empty store reads
    // zero forever, so no number of passes may confirm it.
    await pushPass(sync, []);
    await pushPass(sync, []);
    await pushPass(sync, []);

    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEvents).not.toHaveBeenCalled();
  });

  it("still re-anchors a NONZERO shrink after consecutive-pass confirmation", async () => {
    const client = makeClient();
    const store = createStore();
    const sync = new Org2CloudSessionSync(() => store, client);

    await pushPass(sync, [pushEvent(1), pushEvent(2), pushEvent(3)]);
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);

    // First shrunk read is a candidate only.
    await pushPass(sync, [pushEvent(1), pushEvent(2)]);
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);

    // Second consecutive identical read confirms the user-truncated history.
    await pushPass(sync, [pushEvent(1), pushEvent(2)]);
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(2);
  });
});
