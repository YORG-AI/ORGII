import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  admitCloudConversationTurn,
  claimCloudConversationTurn,
  finishCloudConversationTurn,
  markCloudConversationTurnAccepted,
  renewCloudConversationTurn,
} from "./org2CloudConversationTurnClient";

const ENDPOINT = {
  supabaseUrl: "https://cloud.example",
  anonKey: "anon",
};
const TURN = {
  orgId: "org-1",
  rootSessionId: "root-1",
  turnId: "turn-1",
  deviceId: "11111111-1111-4111-8111-111111111111",
};
const USER_EVENT = {
  id: "user-1",
  chunk_id: "user-1",
  sessionId: "root-1",
  createdAt: "2026-09-05T10:00:00.000Z",
  functionName: "user_message",
  uiCanonical: "user_message",
  actionType: "raw",
  args: {},
  result: { turnIntentId: "turn-1" },
  source: "user",
  displayText: "continue",
  displayStatus: "pending",
  displayVariant: "message",
  activityStatus: "agent",
  payloadRefs: [],
} as SessionEvent;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloud conversation turn RPC client", () => {
  it("uses the 0028 RPC names and exact parameter contract", async () => {
    const payloads = [
      {
        turnId: "turn-1",
        enqueueSeq: 1,
        status: "queued",
        firstSeq: 1,
        lastSeq: 1,
      },
      {
        outcome: "claimed",
        turnId: "turn-1",
        status: "claimed",
        enqueueSeq: 1,
        leaseExpiresAt: "2026-09-05T10:00:30.000Z",
      },
      {
        turnId: "turn-1",
        status: "claimed",
        leaseExpiresAt: "2026-09-05T10:00:40.000Z",
      },
      {
        turnId: "turn-1",
        status: "accepted",
        acceptedAt: "2026-09-05T10:00:01.000Z",
        leaseExpiresAt: "2026-09-05T10:00:31.000Z",
      },
      {
        turnId: "turn-1",
        status: "completed",
        finishedAt: "2026-09-05T10:00:02.000Z",
      },
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify(payloads.shift()), { status: 200 })
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await admitCloudConversationTurn(
      "jwt",
      { ...TURN, event: USER_EVENT },
      ENDPOINT
    );
    await claimCloudConversationTurn(
      "jwt",
      { ...TURN, leaseSeconds: 30 },
      ENDPOINT
    );
    await renewCloudConversationTurn(
      "jwt",
      { ...TURN, leaseSeconds: 30 },
      ENDPOINT
    );
    await markCloudConversationTurnAccepted(
      "jwt",
      { ...TURN, leaseSeconds: 30 },
      ENDPOINT
    );
    await finishCloudConversationTurn(
      "jwt",
      { ...TURN, status: "completed" },
      ENDPOINT
    );

    expect(
      fetchMock.mock.calls.map(([url]) => String(url).split("/").at(-1))
    ).toEqual([
      "cloud_admit_conversation_turn",
      "cloud_claim_conversation_turn",
      "cloud_renew_conversation_turn",
      "cloud_mark_conversation_turn_accepted",
      "cloud_finish_conversation_turn",
    ]);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    ).toStrictEqual({
      p_org_id: "org-1",
      p_root_session_id: "root-1",
      p_turn_id: "turn-1",
      p_event: USER_EVENT,
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    ).toStrictEqual({
      p_org_id: "org-1",
      p_root_session_id: "root-1",
      p_turn_id: "turn-1",
      p_device_id: "11111111-1111-4111-8111-111111111111",
      p_lease_seconds: 30,
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))
    ).toStrictEqual({
      p_org_id: "org-1",
      p_root_session_id: "root-1",
      p_turn_id: "turn-1",
      p_device_id: "11111111-1111-4111-8111-111111111111",
      p_status: "completed",
    });
  });

  it("preserves HTTP status for queue retry classification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ message: "temporary" }), {
            status: 503,
          })
        )
      )
    );

    await expect(
      claimCloudConversationTurn("jwt", { ...TURN, leaseSeconds: 30 }, ENDPOINT)
    ).rejects.toMatchObject({ status: 503 });
  });
});
