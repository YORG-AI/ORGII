import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCollabConflictError } from "../TeamCollaboration/engine/collabSyncEngineHelpers";
import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
} from "./config";
import {
  Org2CloudProjectsError,
  acquireWorkItemLock,
  allocateWorkItemShortId,
  createCloudProjectSyncClient,
  deleteProject,
  deleteWorkItem,
  isOrg2ProjectsErrorCode,
  listOrgCollabState,
  releaseWorkItemLock,
  toCollabOrgState,
  upsertProject,
  upsertWorkItem,
} from "./org2CloudProjectsClient";

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

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  // A fresh Response per call — a shared instance's body can only be read
  // once, and the delete test issues two RPCs against the default.
  fetchMock.mockImplementation(async () => jsonResponse(null));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("org2CloudProjectsClient headers", () => {
  it("sends JWT bearer + Content-Profile on every projects RPC", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "p-1", version: 1 }));
    await upsertProject("jwt-1", {
      orgId: "org-1",
      project: { id: "p-1" },
      baseVersion: null,
    });
    const { url, init } = lastCall();
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_upsert_project`
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ORG2_CLOUD_OFFICIAL_ANON_KEY);
    expect(headers.authorization).toBe("Bearer jwt-1");
    expect(headers["content-profile"]).toBe(ORG2_CLOUD_POSTGREST_SCHEMA);
  });
});

describe("cloud_upsert_project / cloud_upsert_work_item", () => {
  it("ships the OCC body and parses the {id, version} ack", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "p-1", version: 4 }));
    const result = await upsertProject("jwt-1", {
      orgId: "org-1",
      project: { id: "p-1", name: "P", _fieldRevisions: { name: 3 } },
      baseVersion: 3,
    });
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      project: { id: "p-1", name: "P", _fieldRevisions: { name: 3 } },
      base_version: 3,
    });
    expect(result).toEqual({ id: "p-1", version: 4 });
  });

  it("ships null base_version for inserts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "w-1", version: 1 }));
    await upsertWorkItem("jwt-1", {
      orgId: "org-1",
      workItem: { id: "w-1" },
      baseVersion: null,
    });
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      work_item: { id: "w-1" },
      base_version: null,
    });
  });

  it("maps ORG2_CONFLICT into a coded error the shared channel dispatcher matches", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_CONFLICT" }, 409)
    );
    const error = await upsertWorkItem("jwt-1", {
      orgId: "org-1",
      workItem: { id: "w-1" },
      baseVersion: 2,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudProjectsError);
    expect(isOrg2ProjectsErrorCode(error, "ORG2_CONFLICT")).toBe(true);
    // The channel's OCC dispatch goes through the GENERALIZED matcher —
    // this is the seam that lets ProjectSyncChannel drive the cloud backend.
    expect(isCollabConflictError(error)).toBe(true);
  });

  it("never mis-maps a longer future code containing a known token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_CONFLICT_EXTENDED" }, 409)
    );
    const error = await upsertProject("jwt-1", {
      orgId: "org-1",
      project: { id: "p-1" },
      baseVersion: 0,
    }).catch((caught: unknown) => caught);
    expect(isOrg2ProjectsErrorCode(error, "ORG2_CONFLICT")).toBe(false);
    expect((error as Org2CloudProjectsError).code).toBeNull();
  });
});

describe("cloud_delete_project / cloud_delete_work_item", () => {
  it("ships the tombstone bodies", async () => {
    await deleteProject("jwt-1", "org-1", "p-1");
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_project_id: "p-1" });

    await deleteWorkItem("jwt-1", "org-1", "w-1");
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_work_item_id: "w-1" });
  });

  it("surfaces ORG2_ADMIN_REQUIRED (non-admin project delete) as a coded error", async () => {
    // 0013's cloud_delete_project gates on assert_org_admin, which raises
    // ORG2_ADMIN_REQUIRED — NOT ORG2_FORBIDDEN (that one is reserved for a
    // non-holder non-admin lock release).
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_ADMIN_REQUIRED" }, 403)
    );
    const error = await deleteProject("jwt-1", "org-1", "p-1").catch(
      (caught: unknown) => caught
    );
    expect(isOrg2ProjectsErrorCode(error, "ORG2_ADMIN_REQUIRED")).toBe(true);
  });
});

describe("cloud_allocate_work_item_short_id", () => {
  it("parses the {shortId, n} allocation", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ shortId: "AAA-7", n: 7 }));
    const allocated = await allocateWorkItemShortId("jwt-1", "org-1", "p-1");
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_project_id: "p-1" });
    expect(allocated).toEqual({ shortId: "AAA-7", n: 7 });
  });

  it("maps the missing/tombstoned-project rejection to ORG2_CONFLICT", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_CONFLICT" }, 409)
    );
    const error = await allocateWorkItemShortId("jwt-1", "org-1", "p-x").catch(
      (caught: unknown) => caught
    );
    expect(isOrg2ProjectsErrorCode(error, "ORG2_CONFLICT")).toBe(true);
  });
});

describe("cloud_acquire_work_item_lock / cloud_release_work_item_lock", () => {
  it("ships the lock hint under the SQL parameter name lock_payload", async () => {
    // 0013 declares cloud_acquire_work_item_lock(p_org_id, p_work_item_id,
    // lock_payload) — PostgREST resolves RPCs by the exact named body keys,
    // so the design doc's shorthand `lock` would 404 (PGRST202) and every
    // agent start would silently skip server arbitration.
    fetchMock.mockResolvedValueOnce(jsonResponse(12));
    const version = await acquireWorkItemLock("jwt-1", "org-1", "w-1", {
      activeShortId: "AAA-1",
    });
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_work_item_id: "w-1",
      lock_payload: { activeShortId: "AAA-1" },
    });
    expect(version).toBe(12);
  });

  it("release ships the coordinates only and parses the int version", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(13));
    const version = await releaseWorkItemLock("jwt-1", "org-1", "w-1");
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_work_item_id: "w-1" });
    expect(version).toBe(13);
  });

  it("propagates ORG2_CONFLICT while another member holds the lock", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_CONFLICT" }, 409)
    );
    const error = await acquireWorkItemLock("jwt-1", "org-1", "w-1", {}).catch(
      (caught: unknown) => caught
    );
    expect(isOrg2ProjectsErrorCode(error, "ORG2_CONFLICT")).toBe(true);
    expect(isCollabConflictError(error)).toBe(true);
  });

  it("surfaces ORG2_FORBIDDEN (non-holder non-admin release) as a coded error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_FORBIDDEN" }, 403)
    );
    const error = await releaseWorkItemLock("jwt-1", "org-1", "w-1").catch(
      (caught: unknown) => caught
    );
    expect(isOrg2ProjectsErrorCode(error, "ORG2_FORBIDDEN")).toBe(true);
  });
});

describe("cloud_list_org_collab_state", () => {
  it("parses the delta and aliases cloud wire keys to channel keys", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        serverTime: "2026-07-06T00:00:00.000Z",
        projects: [
          { id: "p-1", name: "P", version: 2, updatedByUserId: "u-2" },
        ],
        workItems: [
          {
            id: "w-1",
            version: 5,
            updated_by_user_id: "u-3",
            deleted_at: "2026-07-05T00:00:00.000Z",
          },
        ],
      })
    );
    const state = await listOrgCollabState("jwt-1", "org-1");
    expect(lastBody()).toEqual({ p_org_id: "org-1", since: null });
    expect(state.serverTime).toBe("2026-07-06T00:00:00.000Z");
    // The channel (and Rust apply) read the self-hosted updatedByMemberId /
    // deletedAt keys; cloud values are kept alongside them verbatim.
    expect(state.projects[0]).toMatchObject({
      updatedByMemberId: "u-2",
      updatedByUserId: "u-2",
    });
    expect(state.workItems[0]).toMatchObject({
      updatedByMemberId: "u-3",
      updated_by_user_id: "u-3",
      deletedAt: "2026-07-05T00:00:00.000Z",
      deleted_at: "2026-07-05T00:00:00.000Z",
    });
  });

  it("passes the since cursor through and tolerates an empty delta", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const state = await listOrgCollabState(
      "jwt-1",
      "org-1",
      "2026-07-01T00:00:00.000Z"
    );
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      since: "2026-07-01T00:00:00.000Z",
    });
    expect(state.projects).toEqual([]);
    expect(state.workItems).toEqual([]);
  });
});

describe("toCollabOrgState", () => {
  it("lifts the delta into the CollabOrgState shape the channel consumes", () => {
    const state = toCollabOrgState({
      serverTime: "2026-07-06T00:00:00.000Z",
      projects: [{ id: "p-1" }],
      workItems: [{ id: "w-1" }],
    });
    expect(state.serverTime).toBe("2026-07-06T00:00:00.000Z");
    expect(state.projects).toEqual([{ id: "p-1" }]);
    expect(state.workItems).toEqual([{ id: "w-1" }]);
  });
});

describe("createCloudProjectSyncClient (ProjectSyncChannel adapter)", () => {
  function makeRpc() {
    return {
      upsertProject: vi.fn(async () => ({ id: "p-1", version: 3 })),
      upsertWorkItem: vi.fn(async () => ({ id: "w-1", version: 3 })),
      deleteProject: vi.fn(async () => undefined),
      deleteWorkItem: vi.fn(async () => undefined),
      listOrgCollabState: vi.fn(async () => ({
        serverTime: "2026-07-06T00:00:00.000Z",
        projects: [],
        workItems: [],
      })),
    };
  }

  it("authenticates with the captured JWT", async () => {
    const rpc = makeRpc();
    const client = createCloudProjectSyncClient("jwt-1", rpc);
    await client.upsertProjectMetadata({
      orgId: "org-1",
      project: { id: "p-1" },
      baseVersion: 2,
    });
    expect(rpc.upsertProject).toHaveBeenCalledWith("jwt-1", {
      orgId: "org-1",
      project: { id: "p-1" },
      baseVersion: 2,
    });
  });

  it("defaults baseVersion to the payload's own version (self-hosted contract)", async () => {
    const rpc = makeRpc();
    const client = createCloudProjectSyncClient("jwt-1", rpc);
    await client.upsertWorkItem({
      orgId: "org-1",
      workItem: { id: "w-1", version: 7 },
    });
    expect(rpc.upsertWorkItem).toHaveBeenCalledWith(
      "jwt-1",
      expect.objectContaining({ baseVersion: 7 })
    );

    await client.upsertWorkItem({
      orgId: "org-1",
      workItem: { id: "w-1" },
    });
    expect(rpc.upsertWorkItem).toHaveBeenLastCalledWith(
      "jwt-1",
      expect.objectContaining({ baseVersion: null })
    );
  });

  it("routes deletes and the conflict-path listOrgState with the cursor passthrough", async () => {
    const rpc = makeRpc();
    const client = createCloudProjectSyncClient("jwt-1", rpc);

    await client.deleteProjectMetadata({
      orgId: "org-1",
      projectId: "p-1",
    });
    expect(rpc.deleteProject).toHaveBeenCalledWith("jwt-1", "org-1", "p-1");

    await client.deleteWorkItemMetadata({
      orgId: "org-1",
      workItemId: "w-1",
    });
    expect(rpc.deleteWorkItem).toHaveBeenCalledWith("jwt-1", "org-1", "w-1");

    // The channel's conflict path fetches a FULL listing (no cursor).
    const state = await client.listOrgState({ orgId: "org-1" });
    expect(rpc.listOrgCollabState).toHaveBeenCalledWith(
      "jwt-1",
      "org-1",
      undefined
    );
    expect(state.projects).toEqual([]);
  });
});
