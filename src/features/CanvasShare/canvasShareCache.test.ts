import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasInlinePayload } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/types";

import {
  canvasShareCacheTestApi,
  getOrCreateCanvasShareLink,
} from "./canvasShareCache";
import type { CanvasShareLinkResult } from "./canvasShareProtocol";

const testState = vi.hoisted(() => ({
  build: vi.fn(),
}));

vi.mock("./canvasShareProtocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./canvasShareProtocol")>();
  return {
    ...actual,
    buildCanvasShareLink: testState.build,
  };
});

function selfContained(link: string): CanvasShareLinkResult {
  return { link, kind: "self-contained" };
}

async function awaitReady(payload: CanvasInlinePayload): Promise<void> {
  const lookup = getOrCreateCanvasShareLink(payload);
  if (lookup.phase === "pending") await lookup.promise;
}

describe("canvasShareCache retained accounting", () => {
  beforeEach(() => {
    testState.build.mockReset();
    canvasShareCacheTestApi.reset();
  });

  afterEach(() => {
    canvasShareCacheTestApi.reset();
  });

  it("counts ready result links against the retained-character bound", async () => {
    const linkCharacters = 100 * 1024;
    testState.build.mockImplementation((payload: CanvasInlinePayload) =>
      Promise.resolve(
        selfContained(
          `https://example.test/#/share/g1/${(payload.content ?? "").slice(
            0,
            1
          )}${"x".repeat(linkCharacters)}`
        )
      )
    );
    const contentCharacters = 300 * 1024;
    for (const character of ["a", "b", "c"]) {
      await awaitReady({
        mode: "html",
        content: character.repeat(contentCharacters),
      });
    }

    const snapshot = canvasShareCacheTestApi.snapshot();
    // Key characters alone (3 × ~300 Ki = ~900 Ki) would fit the 1 Mi bound;
    // only link accounting (3 × ~100 Ki more) forces the oldest entry out.
    expect(snapshot.size).toBe(2);
    expect(snapshot.retainedCharacters).toBeGreaterThan(
      2 * (contentCharacters + linkCharacters)
    );
    expect(snapshot.retainedCharacters).toBeLessThanOrEqual(
      canvasShareCacheTestApi.limits.retainedCharacters
    );
  });

  it("re-enforces the bound when a pending entry becomes ready", async () => {
    const links = new Map<string, number>([
      ["a", 1024],
      ["b", 300 * 1024],
    ]);
    testState.build.mockImplementation((payload: CanvasInlinePayload) => {
      const marker = (payload.content ?? "").slice(0, 1);
      return Promise.resolve(
        selfContained(
          `https://example.test/#/share/g1/${"x".repeat(links.get(marker) ?? 0)}`
        )
      );
    });

    await awaitReady({ mode: "html", content: "a".repeat(400 * 1024) });
    // Insertion stays within bounds on key characters (~901 Ki); only the
    // ready transition adds the 300 Ki link that exceeds the 1 Mi bound.
    await awaitReady({ mode: "html", content: "b".repeat(500 * 1024) });

    const snapshot = canvasShareCacheTestApi.snapshot();
    expect(snapshot.size).toBe(1);
    expect(snapshot.retainedCharacters).toBeLessThanOrEqual(
      canvasShareCacheTestApi.limits.retainedCharacters
    );
  });

  it("aborts the in-flight generation when a pending entry is evicted", () => {
    const signals: AbortSignal[] = [];
    testState.build.mockImplementation(
      (
        _payload: CanvasInlinePayload,
        _viewerUrl: string | undefined,
        signal: AbortSignal
      ) => {
        signals.push(signal);
        return new Promise<CanvasShareLinkResult>(() => undefined);
      }
    );

    getOrCreateCanvasShareLink({ mode: "html", content: "pending-0" });
    const abortListener = vi.fn();
    signals[0].addEventListener("abort", abortListener);

    for (
      let index = 1;
      index <= canvasShareCacheTestApi.limits.entries;
      index += 1
    ) {
      getOrCreateCanvasShareLink({ mode: "html", content: `pending-${index}` });
    }

    expect(signals).toHaveLength(canvasShareCacheTestApi.limits.entries + 1);
    expect(abortListener).toHaveBeenCalledOnce();
    expect(signals[0].aborted).toBe(true);
    expect(signals.slice(1).every((signal) => !signal.aborted)).toBe(true);
    expect(canvasShareCacheTestApi.snapshot().size).toBe(
      canvasShareCacheTestApi.limits.entries
    );
  });
});
