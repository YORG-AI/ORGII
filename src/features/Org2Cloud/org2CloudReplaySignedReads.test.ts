import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
} from "./config";
import type { CloudEndpoint } from "./config";
import {
  CLOUD_REPLAY_SIGN_PATH,
  Org2CloudSignerError,
  authorizeReplayRead,
  createGuestReplayObjectReader,
  downloadSignedReplayObject,
  isReplayAuthorizeRpcMissing,
  signReplayReadUrls,
} from "./org2CloudReplaySignedReads";
import { Org2CloudStorageError } from "./org2CloudStorageClient";
import { Org2CloudSyncError } from "./org2CloudSyncClient";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bytesResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(new Uint8Array(bytes), { status });
}

function callAt(index: number): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, init };
}

function lastCall(): { url: string; init: RequestInit } {
  return callAt(fetchMock.mock.calls.length - 1);
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(lastCall().init.body)) as Record<string, unknown>;
}

const ENDPOINT: CloudEndpoint = {
  webOrigin: "https://app.custom.example.com",
  supabaseUrl: "https://db.custom.example.com",
  anonKey: "custom-anon",
  isOfficial: false,
};

const SHARE_TOKEN = "t".repeat(64);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fetchMock.mockReset();
});

describe("authorizeReplayRead", () => {
  it("posts the share token with the anon apikey and NO Authorization header", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        grant: "grant-1",
        expiresAt: "2026-07-24T12:00:00.000Z",
        objects: ["org-1/sess-1/2/1-h1.gz"],
      })
    );

    const grant = await authorizeReplayRead(
      "org-1",
      "sess-1",
      SHARE_TOKEN,
      ENDPOINT
    );

    const { url, init } = lastCall();
    expect(url).toBe(
      `${ENDPOINT.supabaseUrl}/rest/v1/rpc/cloud_authorize_replay_read`
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("custom-anon");
    expect(headers).not.toHaveProperty("authorization");
    expect(headers["content-profile"]).toBe(ORG2_CLOUD_POSTGREST_SCHEMA);
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_session_id: "sess-1",
      p_share_token: SHARE_TOKEN,
    });
    expect(grant).toEqual({
      grant: "grant-1",
      expiresAt: "2026-07-24T12:00:00.000Z",
      objects: ["org-1/sess-1/2/1-h1.gz"],
    });
  });

  it("defaults to the official endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ grant: "grant-1" }));
    await authorizeReplayRead("org-1", "sess-1", SHARE_TOKEN);
    const { url, init } = lastCall();
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_authorize_replay_read`
    );
    expect((init.headers as Record<string, string>).apikey).toBe(
      ORG2_CLOUD_OFFICIAL_ANON_KEY
    );
  });

  it("maps a rejection into Org2CloudSyncError carrying the server message", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_FORBIDDEN" }, 403)
    );
    const error = await authorizeReplayRead(
      "org-1",
      "sess-1",
      SHARE_TOKEN,
      ENDPOINT
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudSyncError);
    expect((error as Org2CloudSyncError).status).toBe(403);
    expect((error as Org2CloudSyncError).code).toBe("ORG2_FORBIDDEN");
  });
});

describe("isReplayAuthorizeRpcMissing", () => {
  it("matches only the PGRST202-style missing-function 404", () => {
    expect(
      isReplayAuthorizeRpcMissing(
        new Org2CloudSyncError(
          "Could not find the function org2_cloud.cloud_authorize_replay_read",
          404
        )
      )
    ).toBe(true);
    expect(
      isReplayAuthorizeRpcMissing(new Org2CloudSyncError("ORG2_FORBIDDEN", 403))
    ).toBe(false);
    expect(
      isReplayAuthorizeRpcMissing(new Org2CloudSyncError("not found", 404))
    ).toBe(false);
    expect(isReplayAuthorizeRpcMissing(new Error("network down"))).toBe(false);
  });
});

describe("signReplayReadUrls", () => {
  it("posts the grant to the web origin's signer route", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        urls: { "org-1/sess-1/2/1-h1.gz": "https://signed.example/1" },
        expiresIn: 600,
      })
    );

    const signed = await signReplayReadUrls("grant-1", ENDPOINT);

    const { url } = lastCall();
    expect(url).toBe(`${ENDPOINT.webOrigin}${CLOUD_REPLAY_SIGN_PATH}`);
    expect(lastBody()).toEqual({ grant: "grant-1" });
    expect(signed).toEqual({
      urls: { "org-1/sess-1/2/1-h1.gz": "https://signed.example/1" },
      expiresIn: 600,
    });
  });

  it("throws Org2CloudStorageError on a signer rejection", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401));
    const error = await signReplayReadUrls("grant-1", ENDPOINT).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Org2CloudStorageError);
    expect((error as Org2CloudStorageError).status).toBe(401);
  });

  it("retries ONCE after a short backoff when the POST fails at network level", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(
        jsonResponse({ urls: { p: "https://signed.example/1" }, expiresIn: 60 })
      );

    const pending = signReplayReadUrls("grant-1", ENDPOINT);
    await vi.advanceTimersByTimeAsync(300);
    const signed = await pending;

    expect(signed.urls).toEqual({ p: "https://signed.example/1" });
    // 2 transport-level attempts inside the first fetchWithTransportRetry,
    // then the single backoff retry.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("maps exhausted network retries to Org2CloudSignerError 'unreachable'", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError("Load failed"));

    const pending = signReplayReadUrls("grant-1", ENDPOINT).catch(
      (caught: unknown) => caught
    );
    await vi.advanceTimersByTimeAsync(300);
    const error = await pending;

    expect(error).toBeInstanceOf(Org2CloudSignerError);
    expect((error as Org2CloudSignerError).code).toBe("unreachable");
    expect((error as Org2CloudSignerError).status).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("never retries an HTTP rejection: 401 maps to 'unauthorized' in one attempt", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad grant" }, 401));

    const error = await signReplayReadUrls("grant-1", ENDPOINT).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(Org2CloudSignerError);
    expect((error as Org2CloudSignerError).code).toBe("unauthorized");
    expect((error as Org2CloudSignerError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies an expired-grant rejection as 'expired'", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401));
    const error = await signReplayReadUrls("grant-1", ENDPOINT).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Org2CloudSignerError);
    expect((error as Org2CloudSignerError).code).toBe("expired");
    expect((error as Org2CloudSignerError).message).toContain(
      "replay sign request failed with 401"
    );
  });

  it("propagates the original transport error without retrying when aborted", async () => {
    const controller = new AbortController();
    const transportError = new TypeError("Load failed");
    fetchMock.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(transportError);
    });

    const error = await signReplayReadUrls(
      "grant-1",
      ENDPOINT,
      controller.signal
    ).catch((caught: unknown) => caught);

    expect(error).toBe(transportError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("downloadSignedReplayObject", () => {
  it("GETs the raw bytes with no extra credentials", async () => {
    fetchMock.mockResolvedValueOnce(bytesResponse(new Uint8Array([1, 2, 3])));
    const bytes = await downloadSignedReplayObject("https://signed.example/1");
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    const { url, init } = lastCall();
    expect(url).toBe("https://signed.example/1");
    expect(init.headers).toBeUndefined();
  });

  it("throws Org2CloudStorageError with the HTTP status on failure", async () => {
    fetchMock.mockResolvedValueOnce(bytesResponse(new Uint8Array(), 403));
    const error = await downloadSignedReplayObject(
      "https://signed.example/1"
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudStorageError);
    expect((error as Org2CloudStorageError).status).toBe(403);
  });
});

describe("createGuestReplayObjectReader", () => {
  const PATH_1 = "org-1/sess-1/2/1-h1.gz";
  const PATH_2 = "org-1/sess-1/2/2-h2.gz";

  function makeReader() {
    return createGuestReplayObjectReader({
      orgId: "org-1",
      sessionId: "sess-1",
      shareToken: SHARE_TOKEN,
      endpoint: ENDPOINT,
    });
  }

  function mockSession(
    urls: Record<string, string>,
    options: { expiresAt?: string; expiresIn?: number } = {}
  ): void {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          grant: "grant-1",
          ...(options.expiresAt !== undefined
            ? { expiresAt: options.expiresAt }
            : {}),
          objects: Object.keys(urls),
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          urls,
          ...(options.expiresIn !== undefined
            ? { expiresIn: options.expiresIn }
            : {}),
        })
      );
  }

  it("authorizes+signs once and serves every object from the cached url map", async () => {
    mockSession({
      [PATH_1]: "https://signed.example/1",
      [PATH_2]: "https://signed.example/2",
    });
    fetchMock
      .mockResolvedValueOnce(bytesResponse(new Uint8Array([1])))
      .mockResolvedValueOnce(bytesResponse(new Uint8Array([2])));
    const reader = makeReader();

    const [first, second] = await Promise.all([
      reader.download(PATH_1),
      reader.download(PATH_2),
    ]);

    expect(first).toEqual(new Uint8Array([1]));
    expect(second).toEqual(new Uint8Array([2]));
    // 1 authorize + 1 sign + 2 GETs — the concurrent walk shares one session.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(callAt(0).url).toContain("cloud_authorize_replay_read");
    expect(callAt(1).url).toContain(CLOUD_REPLAY_SIGN_PATH);
  });

  it("re-authorizes once when the reported deadline passes mid-walk", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T10:00:00.000Z"));
    mockSession(
      { [PATH_1]: "https://signed.example/1" },
      { expiresAt: "2026-07-24T10:00:30.000Z" }
    );
    fetchMock.mockResolvedValueOnce(bytesResponse(new Uint8Array([1])));
    const reader = makeReader();
    expect(await reader.download(PATH_1)).toEqual(new Uint8Array([1]));

    vi.setSystemTime(new Date("2026-07-24T10:01:00.000Z"));
    mockSession(
      { [PATH_1]: "https://signed.example/1b" },
      { expiresAt: "2026-07-24T10:01:30.000Z" }
    );
    fetchMock.mockResolvedValueOnce(bytesResponse(new Uint8Array([2])));
    expect(await reader.download(PATH_1)).toEqual(new Uint8Array([2]));
    expect(lastCall().url).toBe("https://signed.example/1b");

    // The single mid-walk re-authorization is spent: a second expiry serves
    // the stale map instead of looping the grant flow.
    vi.setSystemTime(new Date("2026-07-24T10:02:00.000Z"));
    fetchMock.mockResolvedValueOnce(bytesResponse(new Uint8Array([3])));
    expect(await reader.download(PATH_1)).toEqual(new Uint8Array([3]));
    expect(lastCall().url).toBe("https://signed.example/1b");
  });

  it("re-authorizes once when a signed URL is rejected, then retries the GET", async () => {
    mockSession({ [PATH_1]: "https://signed.example/1" });
    fetchMock.mockResolvedValueOnce(bytesResponse(new Uint8Array(), 403));
    mockSession({ [PATH_1]: "https://signed.example/1b" });
    fetchMock.mockResolvedValueOnce(bytesResponse(new Uint8Array([9])));
    const reader = makeReader();

    expect(await reader.download(PATH_1)).toEqual(new Uint8Array([9]));
    expect(lastCall().url).toBe("https://signed.example/1b");

    // Second rejection after the spent re-authorization propagates.
    fetchMock.mockResolvedValueOnce(bytesResponse(new Uint8Array(), 403));
    const error = await reader
      .download(PATH_1)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudStorageError);
    expect((error as Org2CloudStorageError).status).toBe(403);
  });

  it("fails closed when the signer never covers the requested path", async () => {
    mockSession({ [PATH_1]: "https://signed.example/1" });
    mockSession({ [PATH_1]: "https://signed.example/1b" });
    const reader = makeReader();

    const error = await reader
      .download(PATH_2)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudStorageError);
    expect((error as Org2CloudStorageError).message).toContain(PATH_2);
    // One re-authorization was attempted for the uncovered path, then closed.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("pins the missing-RPC rejection so every download fails without re-probing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "Could not find the function" }, 404)
    );
    const reader = makeReader();

    const first = await reader
      .download(PATH_1)
      .catch((caught: unknown) => caught);
    expect(isReplayAuthorizeRpcMissing(first)).toBe(true);

    const second = await reader
      .download(PATH_2)
      .catch((caught: unknown) => caught);
    expect(isReplayAuthorizeRpcMissing(second)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
