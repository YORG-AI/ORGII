import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
} from "./config";
import {
  Org2CloudStorageError,
  buildReplayObjectPath,
  downloadReplayObject,
  uploadReplayObject,
} from "./org2CloudStorageClient";

const fetchMock = vi.fn();

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("buildReplayObjectPath", () => {
  it("builds the bucket-relative object key", () => {
    expect(buildReplayObjectPath("org-1", "s-1", 3, 7, "abc123")).toBe(
      "org-1/s-1/3/7-abc123.gz"
    );
  });
});

describe("uploadReplayObject", () => {
  it("POSTs raw gzip bytes with JWT + apikey headers", async () => {
    const bytes = new Uint8Array([31, 139, 8, 0]);
    await uploadReplayObject("jwt-1", "org-1/s-1/3/7-abc.gz", bytes);
    const { url, init } = lastCall();
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/storage/v1/object/replay/org-1/s-1/3/7-abc.gz`
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ORG2_CLOUD_OFFICIAL_ANON_KEY);
    expect(headers.authorization).toBe("Bearer jwt-1");
    expect(headers["content-type"]).toBe("application/gzip");
    expect(headers["x-upsert"]).toBeUndefined();
    expect(new Uint8Array(init.body as Uint8Array)).toEqual(bytes);
  });

  it("uses an explicit endpoint and percent-encodes path segments", async () => {
    await uploadReplayObject(
      "jwt-1",
      "org-1/agentsession-a:b/1/1-hash.gz",
      new Uint8Array([1]),
      {
        webOrigin: "https://app.custom.example.com",
        supabaseUrl: "https://db.custom.example.com",
        anonKey: "custom-anon",
        isOfficial: false,
      }
    );
    const { url, init } = lastCall();
    expect(url).toBe(
      "https://db.custom.example.com/storage/v1/object/replay/org-1/agentsession-a%3Ab/1/1-hash.gz"
    );
    expect((init.headers as Record<string, string>).apikey).toBe("custom-anon");
  });

  it("throws a coded storage error on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    const error = await uploadReplayObject(
      "jwt-1",
      "org-1/s-1/1/1-h.gz",
      new Uint8Array([1])
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudStorageError);
    expect((error as Org2CloudStorageError).status).toBe(403);
  });

  it("treats an RLS-wrapped duplicate as success once the object is readable", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statusCode: "403",
            error: "Unauthorized",
            message: "new row violates row-level security policy",
          }),
          { status: 400 }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      uploadReplayObject("jwt-1", "org-1/s-1/1/1-h.gz", new Uint8Array([1]))
    ).resolves.toBeUndefined();
    expect(lastCall().init.method).toBe("HEAD");
  });

  it("still throws when the RLS denial is genuine (object not readable)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statusCode: "403",
            message: "new row violates row-level security policy",
          }),
          { status: 400 }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const error = await uploadReplayObject(
      "jwt-1",
      "org-1/s-1/1/1-h.gz",
      new Uint8Array([1])
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudStorageError);
    expect((error as Org2CloudStorageError).status).toBe(400);
  });

  it("accepts a plain 409 duplicate without a read-back probe", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 409 }));

    await expect(
      uploadReplayObject("jwt-1", "org-1/s-1/1/1-h.gz", new Uint8Array([1]))
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a 400-wrapped KeyAlreadyExists even when the object is unreadable", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          statusCode: "409",
          error: "Duplicate",
          message: "The resource already exists",
          code: "KeyAlreadyExists",
        }),
        { status: 400 }
      )
    );

    await expect(
      uploadReplayObject("jwt-1", "org-1/s-1/1/1-h.gz", new Uint8Array([1]))
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("downloadReplayObject", () => {
  it("GETs the object and returns its raw bytes", async () => {
    const bytes = new Uint8Array([31, 139, 8, 0, 42]);
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(bytes), { status: 200 })
    );
    const result = await downloadReplayObject("jwt-1", "org-1/s-1/3/7-abc.gz");
    const { url, init } = lastCall();
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/storage/v1/object/replay/org-1/s-1/3/7-abc.gz`
    );
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ORG2_CLOUD_OFFICIAL_ANON_KEY);
    expect(headers.authorization).toBe("Bearer jwt-1");
    expect(result).toEqual(bytes);
  });

  it("throws a coded storage error on a missing object", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const error = await downloadReplayObject(
      "jwt-1",
      "org-1/s-1/1/1-h.gz"
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudStorageError);
    expect((error as Org2CloudStorageError).status).toBe(404);
  });

  it("passes request cancellation through to the transport", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const controller = new AbortController();
    await downloadReplayObject(
      "jwt-1",
      "org-1/s-1/1/1-h.gz",
      undefined,
      controller.signal
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal })
    );
  });
});
