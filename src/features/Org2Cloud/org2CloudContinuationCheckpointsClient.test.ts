import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CloudEndpoint } from "./config";
import {
  CONTINUATION_CHECKPOINT_MAX_OBJECT_BYTES,
  Org2CloudContinuationError,
  buildContinuationCheckpointObjectPath,
  downloadContinuationCheckpointObject,
  listContinuationCheckpoints,
  prepareContinuationCheckpoint,
  registerContinuationDevice,
  resolveContinuationRecipients,
  uploadContinuationCheckpointObject,
} from "./org2CloudContinuationCheckpointsClient";

const fetchMock = vi.fn();

const ENDPOINT: CloudEndpoint = {
  webOrigin: "https://app.custom.example.com",
  supabaseUrl: "https://db.custom.example.com",
  anonKey: "custom-anon",
  isOfficial: false,
};

const ORG_ID = "10000000-0000-0000-0000-000000000001";
const CHECKPOINT_ID = "40000000-0000-0000-0000-000000000001";
const DEVICE_ID = "30000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";
const HASH = "a".repeat(64);
const KEY_32 = "A".repeat(43);
const SIGNATURE_64 = "A".repeat(86);
const HEADER = "AQID";

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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function descriptor(bytes: Uint8Array) {
  const objectSha256 = await sha256Hex(bytes);
  return {
    checkpointId: CHECKPOINT_ID,
    orgId: ORG_ID,
    objectPath: buildContinuationCheckpointObjectPath(
      ORG_ID,
      CHECKPOINT_ID,
      objectSha256
    ),
    objectSize: bytes.byteLength,
    objectSha256,
  };
}

function prepareReceipt() {
  return {
    checkpointId: CHECKPOINT_ID,
    bucket: "continuation-checkpoints",
    objectPath: `${ORG_ID}/${CHECKPOINT_ID}/${HASH}.age`,
    objectSize: 1907,
    objectSha256: HASH,
    ageCiphertextLen: 1234,
    ageCiphertextSha256: "b".repeat(64),
    footerSignature: SIGNATURE_64,
    status: "prepared",
    senderUserId: USER_ID,
    senderDeviceId: DEVICE_ID,
    senderKeyVersion: 2,
    senderEncryptionPublicKey: KEY_32,
    senderSigningPublicKey: KEY_32,
    senderKeyFingerprint: "c".repeat(64),
    sourceEpisodeId: "episode-a",
    sourceRuntime: "codex",
    payloadSchema: "org2.portable_conversation",
    payloadSchemaVersion: 2,
    recipientScope: "audience",
    recipientCount: 1,
    recipientSetSha256: "d".repeat(64),
    canonicalHeader: HEADER,
    clientCreatedAt: "2026-08-26T00:00:00Z",
    createdAt: "2026-08-26T00:00:01Z",
    expiresAt: "2026-08-26T01:00:00Z",
    envelopeVersion: 1,
    recipients: [
      {
        recipientUserId: USER_ID,
        deviceId: DEVICE_ID,
        keyVersion: 2,
        encryptionPublicKey: KEY_32,
        signingPublicKey: KEY_32,
        keyFingerprint: "c".repeat(64),
        status: "pending",
      },
    ],
  };
}

function prepareInput() {
  return {
    checkpointId: CHECKPOINT_ID,
    orgId: ORG_ID,
    rootSessionId: "root-a",
    sourceEpisodeId: "episode-a",
    clientCreatedAt: "2026-08-26T00:00:00Z",
    senderDeviceId: DEVICE_ID,
    senderKeyVersion: 2,
    recipientScope: "audience" as const,
    recipients: [
      { recipientUserId: USER_ID, deviceId: DEVICE_ID, keyVersion: 2 },
    ],
    recipientSetSha256: "d".repeat(64),
    canonicalHeader: HEADER,
    sourceRuntime: "codex",
    payloadSchema: "org2.portable_conversation",
    payloadSchemaVersion: 2,
    objectSize: 1907,
    objectSha256: HASH,
    ageCiphertextLen: 1234,
    ageCiphertextSha256: "b".repeat(64),
    footerSignature: SIGNATURE_64,
    expiresAt: "2026-08-26T01:00:00Z",
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("continuation checkpoint RPCs", () => {
  it("registers a public device key against an explicit org endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        keyVersion: 2,
        keyFingerprint: HASH,
        encryptEligible: true,
        deviceLabel: "Neonforge",
      })
    );

    await registerContinuationDevice(
      "jwt",
      {
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        keyVersion: 2,
        encryptionPublicKey: KEY_32,
        signingPublicKey: KEY_32,
        keyFingerprint: HASH,
        deviceLabel: "Neonforge",
      },
      { endpoint: ENDPOINT }
    );

    const { url, init } = lastCall();
    expect(url).toBe(
      `${ENDPOINT.supabaseUrl}/rest/v1/rpc/cloud_register_continuation_device`
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      apikey: ENDPOINT.anonKey,
      authorization: "Bearer jwt",
      "content-profile": "org2_cloud",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      p_org_id: ORG_ID,
      p_device_id: DEVICE_ID,
      p_key_version: 2,
      p_device_label: "Neonforge",
    });
  });

  it("preserves a fail-closed uncovered-audience response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        checkpointable: false,
        recipientScope: "audience",
        reason: "uncoveredAudience",
        recipientCount: 1,
        uncoveredUserIds: [USER_ID],
      })
    );

    await expect(
      resolveContinuationRecipients(
        "jwt",
        {
          orgId: ORG_ID,
          rootSessionId: "root-a",
          recipientScope: "audience",
        },
        { endpoint: ENDPOINT }
      )
    ).resolves.toMatchObject({
      checkpointable: false,
      reason: "uncoveredAudience",
    });
  });

  it("sends portable payload schema, never a receiver target runtime", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(prepareReceipt()));
    await prepareContinuationCheckpoint("jwt", prepareInput(), {
      endpoint: ENDPOINT,
    });

    const body = JSON.parse(String(lastCall().init.body)) as Record<
      string,
      unknown
    >;
    expect(body.p_payload_schema).toBe("org2.portable_conversation");
    expect(body.p_payload_schema_version).toBe(2);
    expect(body).not.toHaveProperty("p_target_runtime");
  });

  it("rejects a well-formed prepare receipt that changes signed metadata", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...prepareReceipt(), payloadSchemaVersion: 3 })
    );
    const error = await prepareContinuationCheckpoint("jwt", prepareInput(), {
      endpoint: ENDPOINT,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudContinuationError);
    expect((error as Org2CloudContinuationError).code).toBe("ORG2_CONFLICT");
  });

  it("extracts only complete known ORG2 error tokens", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          message:
            "ORG2_CONFLICT_EXTENDED then ORG2_CONTINUATION_RECIPIENT_SET_STALE",
        },
        409
      )
    );
    const error = await resolveContinuationRecipients(
      "jwt",
      {
        orgId: ORG_ID,
        rootSessionId: "root-a",
        recipientScope: "audience",
      },
      { endpoint: ENDPOINT }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudContinuationError);
    expect((error as Org2CloudContinuationError).code).toBe(
      "ORG2_CONTINUATION_RECIPIENT_SET_STALE"
    );
  });

  it("rejects a half cursor before contacting Cloud", async () => {
    await expect(
      listContinuationCheckpoints(
        "jwt",
        {
          orgId: ORG_ID,
          deviceId: DEVICE_ID,
          keyVersion: 2,
          afterCreatedAt: "2026-08-26T00:00:00Z",
        },
        { endpoint: ENDPOINT }
      )
    ).rejects.toThrow("both continuation checkpoint cursors");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("opaque continuation ciphertext transport", () => {
  it("validates the complete local size and SHA-256 before upload", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const value = await descriptor(bytes);
    await expect(
      uploadContinuationCheckpointObject(
        "jwt",
        {
          ...value,
          objectPath: buildContinuationCheckpointObjectPath(
            ORG_ID,
            CHECKPOINT_ID,
            HASH
          ),
          objectSha256: HASH,
        },
        bytes,
        ENDPOINT
      )
    ).rejects.toThrow("size or SHA-256 mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads exact opaque bytes without upsert", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const value = await descriptor(bytes);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await uploadContinuationCheckpointObject("jwt", value, bytes, ENDPOINT);
    const { url, init } = lastCall();
    expect(url).toContain(
      `/storage/v1/object/continuation-checkpoints/${ORG_ID}/${CHECKPOINT_ID}/`
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer jwt",
      "content-type": "application/octet-stream",
    });
    expect(init.headers).not.toHaveProperty("x-upsert");
    expect(new Uint8Array(init.body as Uint8Array)).toEqual(bytes);
  });

  it("accepts an ambiguous duplicate only after exact GET verification", async () => {
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const value = await descriptor(bytes);
    fetchMock
      .mockResolvedValueOnce(new Response("duplicate", { status: 409 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));

    await expect(
      uploadContinuationCheckpointObject("jwt", value, bytes, ENDPOINT)
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual([
      "POST",
      "GET",
    ]);
  });

  it("fails closed when an existing object has different bytes", async () => {
    const bytes = new Uint8Array([9, 10, 11, 12]);
    const value = await descriptor(bytes);
    fetchMock
      .mockResolvedValueOnce(new Response("duplicate", { status: 409 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([9, 10, 11, 13]), { status: 200 })
      );

    const error = await uploadContinuationCheckpointObject(
      "jwt",
      value,
      bytes,
      ENDPOINT
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudContinuationError);
    expect((error as Org2CloudContinuationError).code).toBe("ORG2_CONFLICT");
  });

  it("recovers a lost upload response by verifying the immutable object", async () => {
    const bytes = new Uint8Array([13, 14, 15, 16]);
    const value = await descriptor(bytes);
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));

    await expect(
      uploadContinuationCheckpointObject("jwt", value, bytes, ENDPOINT)
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe("GET");
  });

  it("downloads only an exact bounded complete object", async () => {
    const bytes = new Uint8Array([21, 22, 23, 24]);
    const value = await descriptor(bytes);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    await expect(
      downloadContinuationCheckpointObject("jwt", value, ENDPOINT)
    ).resolves.toEqual(bytes);
  });

  it("rejects an oversized response before reading its body", async () => {
    const bytes = new Uint8Array([31]);
    const value = await descriptor(bytes);
    fetchMock.mockResolvedValueOnce(
      new Response(bytes, {
        status: 200,
        headers: {
          "content-length": String(
            CONTINUATION_CHECKPOINT_MAX_OBJECT_BYTES + 1
          ),
        },
      })
    );
    await expect(
      downloadContinuationCheckpointObject("jwt", value, ENDPOINT)
    ).rejects.toThrow("exceeds 16 MiB");
  });
});
