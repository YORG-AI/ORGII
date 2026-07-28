import { afterEach, beforeEach, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { getCloudCapabilities } from "../../org2CloudCapabilities";
import { __STORAGE_SEGMENTS_INTERNALS } from "../../org2CloudSyncClient";

vi.mock("../../org2CloudCapabilities", () => ({
  getCloudCapabilities: vi.fn(),
}));

export {
  bytesToBase64,
  computeSegmentHash,
} from "../../../TeamCollaboration/sync/collabGzip";
export {
  decodeSegmentEvents,
  decodeSegmentEventsFromBytes,
} from "../../../TeamCollaboration/sync/segmentCodec";
export {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
} from "../../config";
export {
  CloudSessionWirePageContractError,
  Org2CloudSyncError,
  __SESSION_LISTING_INTERNALS,
  appendSessionEventWires,
  appendSessionEvents,
  getOrgRepoScopes,
  getSessionEvents,
  isOrg2SyncErrorCode,
  listOrgSessions,
  rewriteSessionEventWires,
  rewriteSessionEvents,
  setOrgRepoScopes,
  uploadSessionEventWires,
  upsertSessionMetadata,
} from "../../org2CloudSyncClient";

export const capabilitiesMock = vi.mocked(getCloudCapabilities);
export const fetchMock = vi.fn();

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

export function lastBody(): Record<string, unknown> {
  return JSON.parse(String(lastCall().init.body)) as Record<string, unknown>;
}

export function makeEvent(id: string): SessionEvent {
  return { id, displayStatus: "completed" } as unknown as SessionEvent;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(jsonResponse(null));
  capabilitiesMock.mockResolvedValue({
    broadcastSignals: false,
    storageSegments: false,
    homeEndpoints: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  capabilitiesMock.mockReset();
  __STORAGE_SEGMENTS_INTERNALS.resetStorageSupport();
});
