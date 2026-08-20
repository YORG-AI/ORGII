// @vitest-environment jsdom
import {
  type RefObject,
  act,
  createElement,
  createRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  canvasShareCacheTestApi,
  refreshCanvasShareLink,
} from "./canvasShareCache";
import { CanvasShareProtocolError } from "./canvasShareProtocol";
import { useCanvasShareDialog } from "./useCanvasShareDialog";

const testState = vi.hoisted(() => ({
  build: vi.fn(),
  copy: vi.fn(),
}));

vi.mock("./canvasShareProtocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./canvasShareProtocol")>();
  return {
    ...actual,
    buildCanvasShareLink: testState.build,
  };
});

vi.mock("@src/util/data/clipboard", () => ({ copyText: testState.copy }));

type ShareController = ReturnType<typeof useCanvasShareDialog>;
type LinkResult =
  | { link: string; kind: "self-contained" }
  | { link: string; kind: "short"; expiresAt: string };

function fullLink(link: string): LinkResult {
  return { link, kind: "self-contained" };
}

const Probe = forwardRef<ShareController>(function Probe(_props, ref) {
  const controller = useCanvasShareDialog();
  useImperativeHandle(ref, () => controller, [controller]);
  return null;
});

describe("useCanvasShareDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;
  let controllerRef: RefObject<ShareController | null>;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    testState.build.mockReset();
    testState.copy.mockReset();
    canvasShareCacheTestApi.reset();
    mountProbe();
  });

  function mountProbe(): void {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mounted = true;
    controllerRef = createRef<ShareController>();
    act(() => root.render(createElement(Probe, { ref: controllerRef })));
  }

  afterEach(() => {
    if (mounted) act(() => root.unmount());
    canvasShareCacheTestApi.reset();
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function controller(): ShareController {
    if (!controllerRef.current) throw new Error("Share controller not mounted");
    return controllerRef.current;
  }

  it("moves from preparing to ready and copies the generated link", async () => {
    testState.build.mockResolvedValue(
      fullLink("https://example.test/#/share/g1/link")
    );
    testState.copy.mockResolvedValue(undefined);

    await act(async () => {
      controller().open({ mode: "html", content: "<p>Hello</p>" }, "Hello");
      await Promise.resolve();
    });

    expect(controller().state).toMatchObject({
      phase: "ready",
      title: "Hello",
      link: "https://example.test/#/share/g1/link",
      linkKind: "self-contained",
      copied: false,
    });

    await act(async () => controller().copy());
    expect(testState.copy).toHaveBeenCalledWith(
      "https://example.test/#/share/g1/link"
    );
    expect(controller().state).toMatchObject({
      phase: "ready",
      copied: true,
    });
  });

  it("does not reopen after a pending encode completes behind a close", async () => {
    let resolveLink: (result: LinkResult) => void = () => undefined;
    let generationSignal: AbortSignal | undefined;
    testState.build.mockImplementation(
      (
        _payload: unknown,
        _viewerUrl: unknown,
        signal: AbortSignal | undefined
      ) => {
        generationSignal = signal;
        return new Promise<LinkResult>((resolve) => {
          resolveLink = resolve;
        });
      }
    );

    act(() => {
      controller().open({ mode: "html", content: "<p>Old</p>" }, "Old");
    });
    expect(controller().state.phase).toBe("preparing");

    act(() => controller().close());
    expect(generationSignal?.aborted).toBe(false);
    await act(async () => resolveLink(fullLink("https://example.test/stale")));

    expect(controller().state.phase).toBe("closed");

    act(() =>
      controller().open(
        { mode: "html", content: "<p>Old</p>" },
        "Cached after close"
      )
    );
    expect(testState.build).toHaveBeenCalledOnce();
    expect(controller().state).toMatchObject({
      phase: "ready",
      link: "https://example.test/stale",
    });
  });

  it("reuses the last successful link after the Canvas tab remounts", async () => {
    const payload = { mode: "html" as const, content: "<p>Cached</p>" };
    testState.build.mockResolvedValue(fullLink("https://example.test/cached"));

    await act(async () => {
      controller().open(payload, "Cached");
      await Promise.resolve();
    });
    act(() => root.unmount());
    mounted = false;
    container.remove();
    mountProbe();
    act(() => controller().open(payload, "Cached again"));

    expect(testState.build).toHaveBeenCalledOnce();
    expect(controller().state).toMatchObject({
      phase: "ready",
      title: "Cached again",
      link: "https://example.test/cached",
      linkKind: "self-contained",
    });
  });

  it("retries a cached fallback without hiding the usable full link", async () => {
    let resolveRetry: (result: LinkResult) => void = () => undefined;
    const payload = { mode: "html" as const, content: "<p>Recover</p>" };
    testState.build
      .mockResolvedValueOnce(fullLink("https://example.test/full"))
      .mockImplementationOnce(
        () =>
          new Promise<LinkResult>((resolve) => {
            resolveRetry = resolve;
          })
      );

    await act(async () => {
      controller().open(payload, "Recover");
      await Promise.resolve();
    });

    act(() => controller().retryShortLink());
    expect(controller().state).toMatchObject({
      phase: "ready",
      link: "https://example.test/full",
      linkKind: "self-contained",
      retryingShortLink: true,
    });
    act(() => controller().retryShortLink());
    expect(testState.build).toHaveBeenCalledTimes(2);

    await act(async () =>
      resolveRetry({
        link: "https://example.test/#/s/recoveredrecoveredreco",
        kind: "short",
        expiresAt: "2099-01-01T00:00:00.000Z",
      })
    );

    expect(controller().state).toMatchObject({
      phase: "ready",
      link: "https://example.test/#/s/recoveredrecoveredreco",
      linkKind: "short",
      retryingShortLink: false,
    });
  });

  it("shares one in-flight retry across concurrent consumers", async () => {
    let resolveRetry: (result: LinkResult) => void = () => undefined;
    const payload = { mode: "html" as const, content: "<p>Concurrent</p>" };
    testState.build
      .mockResolvedValueOnce(fullLink("https://example.test/full"))
      .mockImplementationOnce(
        () =>
          new Promise<LinkResult>((resolve) => {
            resolveRetry = resolve;
          })
      );

    await act(async () => {
      controller().open(payload, "Concurrent");
      await Promise.resolve();
    });

    const first = refreshCanvasShareLink(payload);
    const second = refreshCanvasShareLink(payload);
    expect(first.phase).toBe("pending");
    expect(second.phase).toBe("pending");
    if (first.phase !== "pending" || second.phase !== "pending") {
      throw new Error("Expected a shared pending retry");
    }
    expect(second.promise).toBe(first.promise);
    expect(testState.build).toHaveBeenCalledTimes(2);

    await act(async () =>
      resolveRetry({
        link: "https://example.test/#/s/concurrentconcurrentco",
        kind: "short",
        expiresAt: "2099-01-01T00:00:00.000Z",
      })
    );
  });

  it("regenerates a fallback after its recovery TTL", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const payload = { mode: "html" as const, content: "<p>Fallback</p>" };
    testState.build
      .mockResolvedValueOnce(fullLink("https://example.test/old-full"))
      .mockResolvedValueOnce({
        link: "https://example.test/#/s/recoveredrecoveredreco",
        kind: "short",
        expiresAt: "2099-01-01T00:00:00.000Z",
      } satisfies LinkResult);

    await act(async () => {
      controller().open(payload, "Fallback");
      await Promise.resolve();
    });
    act(() => controller().close());
    nowSpy.mockReturnValue(
      1_000 + canvasShareCacheTestApi.limits.selfContainedTtlMs + 1
    );
    await act(async () => {
      controller().open(payload, "Recovered");
      await Promise.resolve();
    });

    expect(testState.build).toHaveBeenCalledTimes(2);
    expect(controller().state).toMatchObject({
      phase: "ready",
      linkKind: "short",
    });
    nowSpy.mockRestore();
  });

  it("keys the cache by the normalized public snapshot", async () => {
    testState.build.mockResolvedValue(
      fullLink("https://example.test/normalized")
    );

    await act(async () => {
      controller().open(
        {
          mode: "html",
          title: "  Normalized  ",
          content: "<p>Same</p>",
          streaming: false,
        },
        "First"
      );
      await Promise.resolve();
    });
    act(() => controller().close());
    act(() =>
      controller().open(
        { mode: "html", title: "Normalized", content: "<p>Same</p>" },
        "Hydrated"
      )
    );

    expect(testState.build).toHaveBeenCalledOnce();
    expect(controller().state).toMatchObject({
      phase: "ready",
      title: "Hydrated",
      link: "https://example.test/normalized",
    });
  });

  it("shares one in-flight generation for duplicate opens", async () => {
    let resolveLink: (result: LinkResult) => void = () => undefined;
    testState.build.mockReturnValue(
      new Promise<LinkResult>((resolve) => {
        resolveLink = resolve;
      })
    );
    const payload = { mode: "html" as const, content: "<p>Same</p>" };

    act(() => {
      controller().open(payload, "First");
      controller().open(payload, "Latest");
    });
    expect(testState.build).toHaveBeenCalledOnce();

    await act(async () => resolveLink(fullLink("https://example.test/same")));
    expect(controller().state).toMatchObject({
      phase: "ready",
      title: "Latest",
      link: "https://example.test/same",
    });
  });

  it("keeps older cache work from overwriting a newer Canvas snapshot", async () => {
    const signals: AbortSignal[] = [];
    const resolvers = new Map<string, (result: LinkResult) => void>();
    testState.build.mockImplementation(
      (
        payload: { content?: string },
        _viewerUrl: unknown,
        signal: AbortSignal
      ) => {
        signals.push(signal);
        return new Promise<LinkResult>((resolve) => {
          resolvers.set(payload.content ?? "", resolve);
        });
      }
    );

    act(() => {
      controller().open({ mode: "html", content: "<p>First</p>" }, "First");
      controller().open({ mode: "html", content: "<p>Second</p>" }, "Second");
    });

    expect(testState.build).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(false);
    expect(controller().state).toMatchObject({
      phase: "preparing",
      title: "Second",
    });

    await act(async () =>
      resolvers.get("<p>Second</p>")?.(fullLink("https://example.test/second"))
    );
    await act(async () =>
      resolvers.get("<p>First</p>")?.(fullLink("https://example.test/first"))
    );

    expect(controller().state).toMatchObject({
      phase: "ready",
      title: "Second",
      link: "https://example.test/second",
    });
  });

  it("reuses pending generation after the Canvas tab unmounts and remounts", async () => {
    let resolveLink: (result: LinkResult) => void = () => undefined;
    testState.build.mockImplementation(
      () =>
        new Promise<LinkResult>((resolve) => {
          resolveLink = resolve;
        })
    );
    const payload = { mode: "html" as const, content: "<p>Remount</p>" };

    act(() => {
      controller().open(payload, "Before switch");
    });
    act(() => root.unmount());
    mounted = false;
    container.remove();
    mountProbe();

    act(() => controller().open(payload, "After switch"));
    expect(testState.build).toHaveBeenCalledOnce();

    await act(async () =>
      resolveLink(fullLink("https://example.test/remounted"))
    );
    expect(controller().state).toMatchObject({
      phase: "ready",
      title: "After switch",
      link: "https://example.test/remounted",
    });
  });

  it("separates a service outage with an oversized fallback from a too-large Canvas", async () => {
    testState.build
      .mockRejectedValueOnce(
        new CanvasShareProtocolError(
          "short-link-unavailable-too-large",
          "Service unavailable and the snapshot does not fit in a link."
        )
      )
      .mockResolvedValueOnce({
        link: "https://example.test/#/s/recoveredrecoveredreco",
        kind: "short",
        expiresAt: "2099-01-01T00:00:00.000Z",
      } satisfies LinkResult);

    await act(async () => {
      controller().open({ mode: "html", content: "<p>Big</p>" }, "Big");
      await Promise.resolve();
    });
    expect(controller().state).toMatchObject({
      phase: "error",
      error: "short-unavailable-too-large",
    });

    await act(async () => {
      controller().retry();
      await Promise.resolve();
    });

    expect(testState.build).toHaveBeenCalledTimes(2);
    expect(controller().state).toMatchObject({
      phase: "ready",
      linkKind: "short",
      link: "https://example.test/#/s/recoveredrecoveredreco",
    });
  });

  it("still reports a genuinely oversized Canvas as too large", async () => {
    testState.build.mockRejectedValue(
      new CanvasShareProtocolError(
        "source-too-large",
        "Compressed Canvas snapshot exceeds the upload limit."
      )
    );

    await act(async () => {
      controller().open({ mode: "html", content: "<p>Huge</p>" }, "Huge");
      await Promise.resolve();
    });

    expect(controller().state).toMatchObject({
      phase: "error",
      error: "source-too-large",
    });
  });

  it("does not flash an error when shared in-flight work is abort-evicted", async () => {
    testState.build.mockRejectedValue(
      new DOMException("The generation was evicted.", "AbortError")
    );

    await act(async () => {
      controller().open({ mode: "html", content: "<p>Evicted</p>" }, "Evicted");
      await Promise.resolve();
    });

    expect(controller().state).toMatchObject({ phase: "preparing" });
  });

  it("retries after a generation failure without caching the error", async () => {
    testState.build
      .mockRejectedValueOnce(new Error("encode failed"))
      .mockResolvedValueOnce(fullLink("https://example.test/recovered"));

    await act(async () => {
      controller().open({ mode: "html", content: "<p>Retry</p>" }, "Retry");
      await Promise.resolve();
    });
    expect(controller().state).toMatchObject({
      phase: "error",
      error: "unknown",
    });

    await act(async () => {
      controller().retry();
      await Promise.resolve();
    });

    expect(testState.build).toHaveBeenCalledTimes(2);
    expect(controller().state).toMatchObject({
      phase: "ready",
      link: "https://example.test/recovered",
    });
  });

  it("keeps short-link metadata with the cached result", async () => {
    const payload = { mode: "html" as const, content: "<p>Hosted</p>" };
    testState.build.mockResolvedValue({
      link: "https://example.test/#/s/abcdefghijklmnopqrstuv",
      kind: "short",
      expiresAt: "2027-08-09T00:00:00.000Z",
    } satisfies LinkResult);

    await act(async () => {
      controller().open(payload, "Hosted");
      await Promise.resolve();
    });
    act(() => controller().close());
    act(() => controller().open(payload, "Hosted again"));

    expect(testState.build).toHaveBeenCalledOnce();
    expect(controller().state).toMatchObject({
      phase: "ready",
      linkKind: "short",
      expiresAt: "2027-08-09T00:00:00.000Z",
    });
  });

  it("regenerates an expired short link", async () => {
    const payload = { mode: "html" as const, content: "<p>Expired</p>" };
    testState.build
      .mockResolvedValueOnce({
        link: "https://example.test/#/s/expiredexpiredexpiredex",
        kind: "short",
        expiresAt: "2000-01-01T00:00:00.000Z",
      } satisfies LinkResult)
      .mockResolvedValueOnce({
        link: "https://example.test/#/s/freshfreshfreshfreshfr",
        kind: "short",
        expiresAt: "2099-01-01T00:00:00.000Z",
      } satisfies LinkResult);

    await act(async () => {
      controller().open(payload, "Expired");
      await Promise.resolve();
    });
    act(() => controller().close());
    await act(async () => {
      controller().open(payload, "Fresh");
      await Promise.resolve();
    });

    expect(testState.build).toHaveBeenCalledTimes(2);
    expect(controller().state).toMatchObject({
      phase: "ready",
      link: "https://example.test/#/s/freshfreshfreshfreshfr",
    });
  });

  it("bounds the cross-tab cache and evicts the least-recent snapshot", async () => {
    testState.build.mockImplementation((payload: { content?: string }) =>
      Promise.resolve(fullLink(`https://example.test/${payload.content}`))
    );

    for (
      let index = 0;
      index <= canvasShareCacheTestApi.limits.entries;
      index += 1
    ) {
      await act(async () => {
        controller().open(
          { mode: "html", content: `snapshot-${index}` },
          `Snapshot ${index}`
        );
        await Promise.resolve();
      });
      act(() => controller().close());
    }

    expect(canvasShareCacheTestApi.snapshot()).toMatchObject({
      size: canvasShareCacheTestApi.limits.entries,
    });
    await act(async () => {
      controller().open(
        { mode: "html", content: "snapshot-0" },
        "Evicted snapshot"
      );
      await Promise.resolve();
    });

    expect(testState.build).toHaveBeenCalledTimes(
      canvasShareCacheTestApi.limits.entries + 2
    );
  });

  it("bounds retained Canvas source characters independently of entry count", async () => {
    testState.build.mockImplementation((payload: { title?: string }) =>
      Promise.resolve(fullLink(`https://example.test/${payload.title}`))
    );
    const contentSize = 480 * 1024;
    const contents = ["a", "b", "c"].map((character) =>
      character.repeat(contentSize)
    );

    for (const [index, content] of contents.entries()) {
      await act(async () => {
        controller().open(
          { mode: "html", title: `Large ${index}`, content },
          `Large ${index}`
        );
        await Promise.resolve();
      });
      act(() => controller().close());
    }

    const snapshot = canvasShareCacheTestApi.snapshot();
    expect(snapshot.size).toBe(2);
    expect(snapshot.retainedCharacters).toBeLessThanOrEqual(
      canvasShareCacheTestApi.limits.retainedCharacters
    );
  });
});
