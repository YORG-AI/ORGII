/** Shared managed-cloud adapter for every local conversation executor. */
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { findImportedSession } from "@src/features/TeamCollaboration/engine/collabImportIdentity";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";
import { type Session, sessionsAtom } from "@src/store/session";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { getFreshCloudAccessToken } from "../cloudShortId";
import {
  org2CloudAccessSettingsAtom,
  withCloudSessionMode,
} from "../org2CloudAccessSettings";
import { org2CloudAuthAtom } from "../org2CloudAuthAtom";
import {
  type ConversationEventWindow,
  listConversationEventsFrom,
} from "../org2CloudConversationEventsClient";
import { activeConversationRunnersAtom } from "./activeConversationRunnersAtom";
import {
  bumpConversationPlaneSignal,
  conversationPlaneSignalAtom,
} from "./conversationPlaneAtom";
import {
  conversationEventKey,
  mergePlaneIntoTranscript,
} from "./conversationTimeline";
import {
  CONVERSATION_CONTEXT_MAX_ENTRIES,
  type ConversationInitialContext,
} from "./conversationTurnRunner";

export async function getRequiredCloudAccessToken(): Promise<string> {
  const token = await getFreshCloudAccessToken();
  if (!token) throw new Error("cloud sign-in required");
  return token;
}

export interface CloudConversationContextDeps {
  getAccessToken: () => Promise<string>;
  getAuth: () => { userId: string; supabaseUrl: string } | null;
  getSessions: () => Session[];
  loadPlane: (
    accessToken: string,
    params: {
      orgId: string;
      rootSessionId: string;
      afterSeq: number;
      retainLast: number;
    }
  ) => Promise<ConversationEventWindow>;
  loadPersistedEvents: (sessionId: string) => Promise<SessionEvent[]>;
}

function createContextDeps(): CloudConversationContextDeps {
  const store = getInstrumentedStore();
  return {
    getAccessToken: getRequiredCloudAccessToken,
    getAuth: () => store.get(org2CloudAuthAtom),
    getSessions: () => store.get(sessionsAtom),
    loadPlane: (accessToken, params) =>
      listConversationEventsFrom(accessToken, params),
    loadPersistedEvents: (sessionId) =>
      eventStoreProxy
        .getPersistedEvents(sessionId)
        .catch(() => [] as SessionEvent[]),
  };
}

export async function loadCloudConversationInitialContext(
  params: {
    orgId: string;
    rootSessionId: string;
    streamSessionId: string;
    excludeTurnIntentId: string;
  },
  deps: CloudConversationContextDeps = createContextDeps()
): Promise<ConversationInitialContext> {
  const auth = deps.getAuth();
  if (!auth) throw new Error("cloud sign-in required");
  const window = await deps.loadPlane(await deps.getAccessToken(), {
    orgId: params.orgId,
    rootSessionId: params.rootSessionId,
    afterSeq: 0,
    retainLast: CONVERSATION_CONTEXT_MAX_ENTRIES,
  });
  const rows = window.events.filter(
    (row) => row.turnId !== params.excludeTurnIntentId
  );
  const sessions = deps.getSessions();
  const localRoot =
    sessions.find(
      (candidate) => candidate.session_id === params.rootSessionId
    ) ??
    findImportedSession(
      sessions,
      params.orgId,
      params.rootSessionId,
      auth.supabaseUrl
    );
  const rootEvents = localRoot
    ? await deps.loadPersistedEvents(localRoot.session_id)
    : [];
  const timeline = mergePlaneIntoTranscript(
    rootEvents,
    rows,
    params.streamSessionId,
    auth.userId
  );
  const authorByEventKey = new Map(
    rows.map((row) => [
      conversationEventKey(row.event),
      row.authorDisplayName ?? row.authorUserId,
    ])
  );
  const senders = new Map<string, string>();
  for (const event of timeline) {
    const sender = authorByEventKey.get(conversationEventKey(event));
    if (sender) senders.set(event.id, sender);
  }
  return {
    timeline,
    senders,
    readThroughPlaneSeq: window.lastSeq,
  };
}

export async function loadCloudConversationPlaneDelta(
  orgId: string,
  rootSessionId: string,
  afterSeq: number,
  getAccessToken: () => Promise<string> = getRequiredCloudAccessToken
): Promise<ConversationEventWindow> {
  return listConversationEventsFrom(await getAccessToken(), {
    orgId,
    rootSessionId,
    afterSeq,
    retainLast: CONVERSATION_CONTEXT_MAX_ENTRIES,
  });
}

export function registerCloudConversationRunner(input: {
  orgId: string;
  rootSessionId: string;
  runnerSessionId: string;
  turnId: string;
  turnIntentId: string;
}): void {
  const store = getInstrumentedStore();
  store.set(org2CloudAccessSettingsAtom, (current) =>
    withCloudSessionMode(
      current,
      input.orgId,
      input.runnerSessionId,
      COLLAB_SESSION_ACCESS_MODE.OFF
    )
  );
  store.set(activeConversationRunnersAtom, (current) => ({
    ...current,
    [input.rootSessionId]: [
      ...(current[input.rootSessionId] ?? []),
      {
        runnerSessionId: input.runnerSessionId,
        turnId: input.turnId,
        turnIntentId: input.turnIntentId,
      },
    ],
  }));
}

export function settleCloudConversationRunner(
  rootSessionId: string,
  runnerSessionId: string
): void {
  const store = getInstrumentedStore();
  store.set(activeConversationRunnersAtom, (current) => {
    const list = current[rootSessionId];
    if (!list) return current;
    const kept = list.filter(
      (runner) => runner.runnerSessionId !== runnerSessionId
    );
    if (kept.length === list.length) return current;
    const next = { ...current };
    if (kept.length === 0) delete next[rootSessionId];
    else next[rootSessionId] = kept;
    return next;
  });
}

export function signalCloudConversationPlane(orgId: string): void {
  const store = getInstrumentedStore();
  bumpConversationPlaneSignal(
    (update) => store.set(conversationPlaneSignalAtom, update),
    orgId
  );
}
