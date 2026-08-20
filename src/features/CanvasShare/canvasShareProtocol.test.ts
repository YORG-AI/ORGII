import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  CANVAS_SHARE_API_URL,
  CANVAS_SHARE_HASH_PREFIX,
  CANVAS_SHARE_SHORT_HASH_PREFIX,
  CANVAS_SHARE_VIEWER_URL,
  MAX_CANVAS_SHARE_SOURCE_BYTES,
  buildCanvasShareLink,
  buildSelfContainedCanvasShareLink,
  createCanvasShareEnvelope,
  encodeCanvasSharePayload,
  getCanvasShareAvailability,
  isCanvasShareEnvelope,
  parseCanvasShareHash,
} from "./canvasShareProtocol";

/** Builds a raw share hash from an arbitrary envelope, bypassing producers. */
async function craftShareHash(envelope: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const byte of compressed) binary += String.fromCharCode(byte);
  const encoded = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${CANVAS_SHARE_HASH_PREFIX}${encoded}`;
}

describe("Canvas share protocol", () => {
  it("uses the ORG2-owned origin for hosted and fallback links", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "abcdefghijklmnopqrstuv",
          expiresAt: "2027-08-09T00:00:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      expect(CANVAS_SHARE_API_URL).toBe(
        "https://canvas.org2.dev/api/canvas-shares"
      );
      expect(CANVAS_SHARE_VIEWER_URL).toBe("https://canvas.org2.dev/");
      await expect(
        buildCanvasShareLink({ mode: "html", content: "<p>Hosted</p>" })
      ).resolves.toEqual({
        link: "https://canvas.org2.dev/#/s/abcdefghijklmnopqrstuv",
        kind: "short",
        expiresAt: "2027-08-09T00:00:00.000Z",
      });
      expect(String(fetchSpy.mock.calls[0][0])).toBe(CANVAS_SHARE_API_URL);
      expect(buildSelfContainedCanvasShareLink("encoded-payload")).toBe(
        "https://canvas.org2.dev/#/share/g1/encoded-payload"
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("round-trips only the selected Canvas snapshot", async () => {
    const controller = new AbortController();
    const payloadWithPrivateFields = {
      mode: "react" as const,
      title: "Interactive prototype",
      content: "function App(){ return <button>Start</button>; }",
      eventId: "event-secret",
      revisesEventId: "event-older",
      streaming: false,
    };
    const encoded = await encodeCanvasSharePayload(
      payloadWithPrivateFields,
      controller.signal
    );
    const link = buildSelfContainedCanvasShareLink(
      encoded,
      "https://example.test/viewer/"
    );

    const hash = new URL(link).hash;
    expect(hash.startsWith(CANVAS_SHARE_HASH_PREFIX)).toBe(true);
    await expect(parseCanvasShareHash(hash)).resolves.toEqual({
      version: 1,
      canvas: {
        mode: "react",
        title: "Interactive prototype",
        content: "function App(){ return <button>Start</button>; }",
      },
    });
    expect(link).not.toContain("event-secret");
    expect(link).not.toContain("event-older");
  });

  it("round-trips a realistic large interactive Canvas", async () => {
    const content =
      `function App(){const [step,setStep]=React.useState(0);return <button onClick={()=>setStep(step+1)}>Step {step}</button>;}`.repeat(
        180
      );
    const encoded = await encodeCanvasSharePayload({
      mode: "react",
      title: "Large prototype",
      content,
    });
    const link = buildSelfContainedCanvasShareLink(
      encoded,
      "https://example.test/viewer/"
    );

    const decoded = await parseCanvasShareHash(new URL(link).hash);
    expect(decoded.canvas.content).toBe(content);
    expect(link.length).toBeLessThan(64 * 1024);
  });

  it("does not allow incomplete, streaming, local URL, or oversized Canvases", () => {
    expect(getCanvasShareAvailability(null, false)).toEqual({
      available: false,
      reason: "empty",
    });
    expect(
      getCanvasShareAvailability(
        { mode: "html", content: "<p>Still changing</p>" },
        true
      )
    ).toEqual({ available: false, reason: "streaming" });
    expect(
      getCanvasShareAvailability(
        { mode: "url", url: "file:///tmp/a.html" },
        false
      )
    ).toEqual({ available: false, reason: "local-url" });
    expect(
      getCanvasShareAvailability(
        {
          mode: "html",
          content: "x".repeat(MAX_CANVAS_SHARE_SOURCE_BYTES + 1),
        },
        false
      )
    ).toEqual({ available: false, reason: "source-too-large" });
  });

  it("avoids UTF-8 allocation for ordinary Canvas eligibility checks", () => {
    const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      expect(
        getCanvasShareAvailability(
          {
            mode: "html",
            content: "x".repeat(Math.floor(MAX_CANVAS_SHARE_SOURCE_BYTES / 3)),
          },
          false
        )
      ).toEqual({ available: true });
      expect(encodeSpy).not.toHaveBeenCalled();

      expect(
        getCanvasShareAvailability(
          {
            mode: "html",
            content: "你".repeat(
              Math.floor(MAX_CANVAS_SHARE_SOURCE_BYTES / 3) + 1
            ),
          },
          false
        )
      ).toEqual({ available: false, reason: "source-too-large" });
      expect(encodeSpy).toHaveBeenCalledOnce();
    } finally {
      encodeSpy.mockRestore();
    }
  });

  it("rejects malformed public links at the decoding boundary", async () => {
    await expect(
      parseCanvasShareHash(`${CANVAS_SHARE_HASH_PREFIX}not-a-gzip-payload`)
    ).rejects.toMatchObject({ code: "invalid-payload" });
  });

  it("rejects a compressed oversized payload at the decoding boundary", async () => {
    const content = "x".repeat(MAX_CANVAS_SHARE_SOURCE_BYTES + 1);
    await expect(
      buildCanvasShareLink(
        { mode: "html", content },
        "https://example.test/viewer/"
      )
    ).rejects.toMatchObject({ code: "source-too-large" });
  });

  it("does no encoding when generation is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      await expect(
        encodeCanvasSharePayload(
          { mode: "html", content: "<p>Cancelled</p>" },
          controller.signal
        )
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(encodeSpy).not.toHaveBeenCalled();
    } finally {
      encodeSpy.mockRestore();
    }
  });

  it("prefers a compact hosted link when the upload succeeds", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "abcdefghijklmnopqrstuv",
          expiresAt: "2027-08-09T00:00:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await buildCanvasShareLink(
        { mode: "html", content: "<p>Short</p>" },
        "https://example.test/viewer/",
        undefined,
        "https://api.example.test/canvas-shares"
      );

      expect(result).toEqual({
        link: `https://example.test/viewer/${CANVAS_SHARE_SHORT_HASH_PREFIX}abcdefghijklmnopqrstuv`,
        kind: "short",
        expiresAt: "2027-08-09T00:00:00.000Z",
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.payload).toMatch(/^[A-Za-z0-9_-]+$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to a self-contained link when the upload is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    try {
      const result = await buildCanvasShareLink(
        { mode: "html", content: "<p>Still shareable</p>" },
        "https://example.test/viewer/",
        undefined,
        "https://api.example.test/canvas-shares"
      );

      expect(result.kind).toBe("self-contained");
      expect(result.link).toContain(CANVAS_SHARE_HASH_PREFIX);
      await expect(
        parseCanvasShareHash(new URL(result.link).hash)
      ).resolves.toMatchObject({
        canvas: { content: "<p>Still shareable</p>" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("private and loopback URL rejection", () => {
    const localUrls = [
      "http://localhost/dashboard",
      "http://localhost:3000/app",
      "http://app.localhost/preview",
      "http://myhost.local/panel",
      "http://service.internal/api",
      "http://127.0.0.1/",
      "http://127.8.9.10/loopback-block",
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.10/router",
      "http://169.254.169.254/latest/meta-data",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:7f00:1]/",
    ];
    const publicUrls = [
      "https://example.com/page",
      "http://example.com/page",
      "https://172.15.0.1/",
      "https://172.32.0.1/",
      "https://11.22.33.44/",
      "https://internal.example.com/",
      "https://localhost.example.com/",
      "https://[2001:db8::1]/",
    ];

    it("rejects local, loopback, and private-range URLs at the producer", () => {
      for (const url of localUrls) {
        expect(
          getCanvasShareAvailability({ mode: "url", url }, false),
          url
        ).toEqual({ available: false, reason: "local-url" });
      }
    });

    it("still accepts publicly routable URLs at the producer", () => {
      for (const url of publicUrls) {
        expect(
          getCanvasShareAvailability({ mode: "url", url }, false),
          url
        ).toEqual({ available: true });
      }
    });

    it("rejects the same hosts at the decode validator", async () => {
      for (const url of localUrls) {
        expect(
          isCanvasShareEnvelope({ version: 1, canvas: { mode: "url", url } }),
          url
        ).toBe(false);
      }
      for (const url of publicUrls) {
        expect(
          isCanvasShareEnvelope({ version: 1, canvas: { mode: "url", url } }),
          url
        ).toBe(true);
      }
      const craftedHash = await craftShareHash({
        version: 1,
        canvas: { mode: "url", url: "http://192.168.1.10/panel" },
      });
      await expect(parseCanvasShareHash(craftedHash)).rejects.toMatchObject({
        code: "invalid-payload",
      });
    });
  });

  describe("upload outage with an oversized fallback", () => {
    // Random base64 text stays incompressible enough that the gzip+base64url
    // fallback fragment exceeds the 64 Ki link cap while the raw source and
    // the hosted 768 Ki upload cap are both respected.
    const incompressibleContent = randomBytes(96 * 1024).toString("base64");

    it("reports a retryable outage instead of claiming the Canvas is too large", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      try {
        await expect(
          buildCanvasShareLink(
            { mode: "html", content: incompressibleContent },
            "https://example.test/viewer/",
            undefined,
            "https://api.example.test/canvas-shares"
          )
        ).rejects.toMatchObject({
          code: "short-link-unavailable-too-large",
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("keeps reporting a genuinely oversized source as too large", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      try {
        await expect(
          buildCanvasShareLink(
            {
              mode: "html",
              content: "x".repeat(MAX_CANVAS_SHARE_SOURCE_BYTES + 1),
            },
            "https://example.test/viewer/",
            undefined,
            "https://api.example.test/canvas-shares"
          )
        ).rejects.toMatchObject({ code: "source-too-large" });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("still uploads the same snapshot once the service recovers", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "abcdefghijklmnopqrstuv",
            expiresAt: "2027-08-09T00:00:00.000Z",
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        )
      );
      vi.stubGlobal("fetch", fetchSpy);
      try {
        await expect(
          buildCanvasShareLink(
            { mode: "html", content: incompressibleContent },
            "https://example.test/viewer/",
            undefined,
            "https://api.example.test/canvas-shares"
          )
        ).resolves.toMatchObject({ kind: "short" });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("mode validation at the producing boundary", () => {
    it("reports an unsupported mode as unavailable", () => {
      expect(
        getCanvasShareAvailability(
          { mode: "pdf" as never, content: "binary" },
          false
        )
      ).toEqual({ available: false, reason: "unsupported-mode" });
    });

    it("rejects envelope creation for an unsupported mode with a typed error", () => {
      expect(() =>
        createCanvasShareEnvelope({ mode: "pdf" as never, content: "binary" })
      ).toThrowError(
        expect.objectContaining({
          name: "CanvasShareProtocolError",
          code: "invalid-payload",
        })
      );
    });
  });

  it("fails loudly on a misconfigured share API URL instead of falling back", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await expect(
        buildCanvasShareLink(
          { mode: "html", content: "<p>Misconfigured</p>" },
          "https://example.test/viewer/",
          undefined,
          "not a valid absolute url"
        )
      ).rejects.toMatchObject({ code: "invalid-payload" });
      await expect(
        buildCanvasShareLink(
          { mode: "html", content: "<p>Misconfigured</p>" },
          "https://example.test/viewer/",
          undefined,
          "http://insecure.example/api"
        )
      ).rejects.toMatchObject({ code: "invalid-payload" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes a newer-version envelope from corruption when decoding", async () => {
    const newerHash = await craftShareHash({
      version: 2,
      canvas: { mode: "html", content: "<p>From the future</p>" },
    });
    await expect(parseCanvasShareHash(newerHash)).rejects.toMatchObject({
      code: "unsupported-version",
      message: expect.stringContaining("newer version"),
    });
  });

  describe("title truncation at code-point boundaries", () => {
    it("never bisects an emoji surrogate pair at the 200-unit cap", async () => {
      const envelope = createCanvasShareEnvelope({
        mode: "html",
        title: `${"x".repeat(199)}😀`,
        content: "<p>Emoji title</p>",
      });
      expect(envelope.canvas.title).toBe("x".repeat(199));
      expect(envelope.canvas.title).not.toContain("�");

      const encoded = await encodeCanvasSharePayload({
        mode: "html",
        title: `${"x".repeat(199)}😀`,
        content: "<p>Emoji title</p>",
      });
      const link = buildSelfContainedCanvasShareLink(
        encoded,
        "https://example.test/viewer/"
      );
      const decoded = await parseCanvasShareHash(new URL(link).hash);
      expect(decoded.canvas.title).toBe("x".repeat(199));
    });

    it("never bisects a CJK extension character at the cap", () => {
      const envelope = createCanvasShareEnvelope({
        mode: "html",
        title: `a${"\u{20000}".repeat(100)}`,
        content: "<p>CJK title</p>",
      });
      expect(envelope.canvas.title).toBe(`a${"\u{20000}".repeat(99)}`);
      expect(envelope.canvas.title).not.toContain("�");
      expect(envelope.canvas.title?.length).toBe(199);
    });

    it("keeps a title that ends exactly on a pair boundary intact", () => {
      const envelope = createCanvasShareEnvelope({
        mode: "html",
        title: "\u{20000}".repeat(100),
        content: "<p>Exact fit</p>",
      });
      expect(envelope.canvas.title).toBe("\u{20000}".repeat(100));
      expect(envelope.canvas.title?.length).toBe(200);
    });
  });
});
