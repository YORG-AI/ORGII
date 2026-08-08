import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
} from "../config";
import {
  MemberRuntimeError,
  clearMemberRuntime,
  getMemberUsage,
  isMemberRuntimeErrorCode,
  listMemberRuntime,
  setOrgRuntimeTelemetry,
  upsertMemberRuntime,
} from "./memberRuntimeClient";
import type { UpsertMemberRuntimeInput } from "./types";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(lastCall().init.body)) as Record<string, unknown>;
}

const STATUS_INPUT: UpsertMemberRuntimeInput = {
  status: {
    machine: {
      deviceId: "dev-1",
      machineLabel: "Harry's Mac",
      osName: "macOS",
      osVersion: "15.5",
      chipType: "Apple M3",
      appVersion: "1.2.3",
    },
    sample: {
      cpuPercent: 42.5,
      memUsedMb: 8_000,
      memTotalMb: 16_000,
      gpuPercent: null,
      sampledOverMs: 800,
      sampledAtMs: 1_753_000_000_000,
    },
  },
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(jsonResponse(null));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("memberRuntimeClient headers and routing", () => {
  it("sends JWT bearer + Content-Profile to the org-routed RPC url", async () => {
    await upsertMemberRuntime("jwt-1", "org-1", STATUS_INPUT);
    const { url, init } = lastCall();
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_upsert_member_runtime`
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ORG2_CLOUD_OFFICIAL_ANON_KEY);
    expect(headers.authorization).toBe("Bearer jwt-1");
    expect(headers["content-profile"]).toBe(ORG2_CLOUD_POSTGREST_SCHEMA);
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_status: STATUS_INPUT.status,
    });
  });

  it("omits absent optional parts so the RPC's partial-update semantics hold", async () => {
    await upsertMemberRuntime("jwt-1", "org-1", {
      usageDays: [
        {
          day: "2026-07-29",
          bucket: "claude",
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          totalTokens: 10,
          costUsd: 0.5,
          sessions: 1,
          requests: 2,
        },
      ],
    });
    const body = lastBody();
    expect(body.p_usage_days).toHaveLength(1);
    expect(body).not.toHaveProperty("p_status");
    expect(body).not.toHaveProperty("p_profile");
  });
});

describe("memberRuntimeClient error-code parsing", () => {
  it("maps ORG2_RUNTIME_DISABLED into a coded error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_RUNTIME_DISABLED" }, 400)
    );
    const error = await upsertMemberRuntime(
      "jwt-1",
      "org-1",
      STATUS_INPUT
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MemberRuntimeError);
    expect((error as MemberRuntimeError).code).toBe("ORG2_RUNTIME_DISABLED");
    expect((error as MemberRuntimeError).status).toBe(400);
    expect(isMemberRuntimeErrorCode(error, "ORG2_RUNTIME_DISABLED")).toBe(true);
    expect(isMemberRuntimeErrorCode(error, "ORG2_RUNTIME_TOO_LARGE")).toBe(
      false
    );
  });

  it("maps ORG2_RUNTIME_TOO_LARGE even with surrounding message text", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { message: "ERROR: ORG2_RUNTIME_TOO_LARGE (status part)" },
        400
      )
    );
    const error = await upsertMemberRuntime(
      "jwt-1",
      "org-1",
      STATUS_INPUT
    ).catch((caught: unknown) => caught);
    expect(isMemberRuntimeErrorCode(error, "ORG2_RUNTIME_TOO_LARGE")).toBe(
      true
    );
  });

  it("keeps the code null for unrecognized failures", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));
    const error = await listMemberRuntime("jwt-1", "org-1").catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(MemberRuntimeError);
    expect((error as MemberRuntimeError).code).toBeNull();
    expect((error as MemberRuntimeError).status).toBe(500);
  });

  it("synthesizes a message when the failure body has none", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 502 }));
    const error = await clearMemberRuntime("jwt-1", "org-1").catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(MemberRuntimeError);
    expect((error as MemberRuntimeError).message).toContain(
      "cloud_clear_member_runtime"
    );
  });
});

describe("listMemberRuntime", () => {
  it("parses entries and degrades malformed jsonb blobs per field", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        members: [
          {
            userId: "user-1",
            displayName: "Ada",
            avatarUrl: null,
            role: "admin",
            reportedAt: "2026-07-29T09:00:00Z",
            machine: STATUS_INPUT.status?.machine,
            sample: STATUS_INPUT.status?.sample,
            stats: {
              totalSessions: 321,
              recentUsage24h: {
                startMs: 1_753_000_000_000,
                endMs: 1_753_086_400_000,
                summary: {
                  sessionCount: 2,
                  requestCount: 3,
                  inputTokens: 10,
                  outputTokens: 20,
                  cacheReadTokens: 30,
                  cacheWriteTokens: 40,
                  realTotalTokens: 100,
                  totalTokens: 100,
                  costUsd: 1.25,
                  estimatedCostUsd: 1.25,
                  recordedCostUsd: 0,
                  cacheHitRate: 0.375,
                  byBucket: [
                    {
                      bucket: "claude",
                      sessionCount: 2,
                      realTotalTokens: 100,
                      costUsd: 1.25,
                    },
                  ],
                },
                trends: [
                  {
                    bucketMs: 1_753_000_000_000,
                    inputTokens: 10,
                    outputTokens: 20,
                    cacheReadTokens: 30,
                    cacheWriteTokens: 40,
                    costUsd: 1.25,
                  },
                ],
              },
            },
            builderTypeCode: "MDFS",
            profile: { code: "MDFS", axes: [], extraFutureField: 1 },
            installedAgents: [{ id: "claude", status: "installed" }],
            profileUpdatedAt: null,
            agentsUpdatedAt: null,
            recentDays: [
              {
                day: "2026-07-29",
                bucket: "claude",
                inputTokens: 1,
                outputTokens: 2,
                cacheReadTokens: 3,
                cacheWriteTokens: 4,
                totalTokens: 10,
                costUsd: 0.5,
                sessions: 1,
                requests: 2,
              },
            ],
            someAdditiveServerField: true,
          },
          {
            userId: "user-2",
            displayName: null,
            role: "member",
            reportedAt: null,
            machine: { totally: "malformed" },
            sample: "not-an-object",
            stats: {
              totalSessions: 7,
              recentUsage24h: { startMs: "malformed" },
            },
            builderTypeCode: null,
            profile: null,
            installedAgents: "garbage",
            recentDays: [{ day: "2026-07-29", bucket: "not-a-bucket" }],
          },
        ],
      })
    );
    const members = await listMemberRuntime("jwt-1", "org-1");
    expect(lastCall().url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_list_member_runtime`
    );
    expect(members).toHaveLength(2);

    expect(members[0].userId).toBe("user-1");
    expect(members[0].machine?.deviceId).toBe("dev-1");
    expect(members[0].sample?.cpuPercent).toBe(42.5);
    expect(members[0].stats?.totalSessions).toBe(321);
    expect(members[0].stats?.recentUsage24h?.summary.realTotalTokens).toBe(100);
    expect(members[0].stats?.recentUsage24h?.trends).toHaveLength(1);
    expect(members[0].profile?.code).toBe("MDFS");
    expect(members[0].installedAgents).toEqual([
      { id: "claude", status: "installed" },
    ]);
    expect(members[0].recentDays).toHaveLength(1);

    // Malformed blobs degrade to null/[] instead of failing the roster.
    expect(members[1].displayName).toBeNull();
    expect(members[1].machine).toBeNull();
    expect(members[1].sample).toBeNull();
    expect(members[1].stats).toEqual({
      totalSessions: 7,
      recentUsage24h: undefined,
    });
    expect(members[1].profile).toBeNull();
    expect(members[1].installedAgents).toEqual([]);
    expect(members[1].recentDays).toEqual([]);
  });

  it("answers an empty roster for an empty payload", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ members: [] }));
    await expect(listMemberRuntime("jwt-1", "org-1")).resolves.toEqual([]);
  });
});

describe("getMemberUsage", () => {
  it("sends the day-span args and parses the rows", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        days: [
          {
            day: "2026-07-01",
            bucket: "codex",
            inputTokens: 5,
            outputTokens: 6,
            cacheReadTokens: 7,
            cacheWriteTokens: 8,
            totalTokens: 26,
            costUsd: 1,
            sessions: 2,
            requests: 3,
          },
        ],
      })
    );
    const days = await getMemberUsage(
      "jwt-1",
      "org-1",
      "user-2",
      "2026-07-01",
      "2026-07-29"
    );
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_user_id: "user-2",
      p_from_day: "2026-07-01",
      p_to_day: "2026-07-29",
    });
    expect(days).toHaveLength(1);
    expect(days[0].bucket).toBe("codex");
  });
});

describe("setOrgRuntimeTelemetry", () => {
  it("parses the stored record and mirrors the server clamp", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        runtimeTelemetry: { enabled: true, intervalMinutes: 90 },
      })
    );
    await expect(
      setOrgRuntimeTelemetry("jwt-1", "org-1", true, 90)
    ).resolves.toEqual({ enabled: true, intervalMinutes: 90 });
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_enabled: true,
      p_interval_minutes: 90,
    });

    // A backend answering outside the clamp is re-clamped locally.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        runtimeTelemetry: { enabled: false, intervalMinutes: 1 },
      })
    );
    await expect(
      setOrgRuntimeTelemetry("jwt-1", "org-1", false, 1)
    ).resolves.toEqual({ enabled: false, intervalMinutes: 15 });
  });
});
