import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PositionSyncHandlers } from "@src/features/SessionSetup/hooks/useWebviewPositionSync";
import { attachWebviewPositionSync } from "@src/features/SessionSetup/hooks/useWebviewPositionSync";

// ---------------------------------------------------------------------------
// Fake RAF / timer environment
// ---------------------------------------------------------------------------

type FrameCallback = (timestamp: number) => void;

function makeEnv() {
  const pendingFrames: Map<number, FrameCallback> = new Map();
  let nextFrameId = 1;

  const pendingIntervals: Map<
    ReturnType<typeof setInterval>,
    { cb: () => void; ms: number }
  > = new Map();
  let nextIntervalId = 1000 as unknown as ReturnType<typeof setInterval>;

  const eventListeners: Map<string, EventListener[]> = new Map();

  const env: PositionSyncHandlers = {
    addEventListener: vi.fn((type, listener) => {
      const list = eventListeners.get(type) ?? [];
      list.push(listener);
      eventListeners.set(type, list);
    }),
    removeEventListener: vi.fn((type, listener) => {
      const list = eventListeners.get(type) ?? [];
      eventListeners.set(
        type,
        list.filter((l) => l !== listener)
      );
    }),
    requestAnimationFrame: vi.fn((cb) => {
      const id = nextFrameId++;
      pendingFrames.set(id, cb as FrameCallback);
      return id;
    }),
    cancelAnimationFrame: vi.fn((id) => {
      pendingFrames.delete(id);
    }),
    setInterval: vi.fn((cb, _ms) => {
      const id = nextIntervalId;
      nextIntervalId = (Number(nextIntervalId) + 1) as unknown as ReturnType<
        typeof setInterval
      >;
      pendingIntervals.set(id, { cb, ms: _ms });
      return id;
    }),
    clearInterval: vi.fn((id) => {
      pendingIntervals.delete(id);
    }),
  };

  const flush = {
    /** Run all currently queued animation frames. */
    frames() {
      const ids = [...pendingFrames.keys()];
      for (const id of ids) {
        const cb = pendingFrames.get(id);
        pendingFrames.delete(id);
        cb?.(performance.now());
      }
    },
    /** Fire each registered interval callback once. */
    interval() {
      for (const { cb } of pendingIntervals.values()) {
        cb();
      }
    },
    /** Emit a window event to all registered listeners. */
    event(type: string) {
      for (const listener of eventListeners.get(type) ?? []) {
        listener(new Event(type));
      }
    },
  };

  return { env, flush, pendingFrames, pendingIntervals, eventListeners };
}

// ---------------------------------------------------------------------------
// Fake container ref helpers
// ---------------------------------------------------------------------------

function makeRef(
  rect: { left: number; top: number; width: number; height: number } | null
) {
  const el =
    rect === null
      ? null
      : ({
          getBoundingClientRect: () => ({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }),
        } as unknown as HTMLElement);
  return { current: el };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attachWebviewPositionSync", () => {
  let updatePosition: ReturnType<typeof vi.fn>;
  const defaultRect = { left: 10, top: 20, width: 300, height: 400 };

  beforeEach(() => {
    updatePosition = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("initial call on attach", () => {
    it("calls updatePosition after the first RAF when rect differs from zero", () => {
      const { env, flush } = makeEnv();
      const ref = makeRef(defaultRect);

      attachWebviewPositionSync(ref, updatePosition, 200, env);
      flush.frames();

      expect(updatePosition).toHaveBeenCalledTimes(1);
    });

    it("does not call updatePosition when container ref is null", () => {
      const { env, flush } = makeEnv();
      const ref = makeRef(null);

      attachWebviewPositionSync(ref, updatePosition, 200, env);
      flush.frames();

      expect(updatePosition).not.toHaveBeenCalled();
    });

    it("does not call updatePosition when rect matches initial zero state", () => {
      const { env, flush } = makeEnv();
      const ref = makeRef({ left: 0, top: 0, width: 0, height: 0 });

      attachWebviewPositionSync(ref, updatePosition, 200, env);
      flush.frames();

      expect(updatePosition).not.toHaveBeenCalled();
    });
  });

  describe("deduplication — RAF coalescing", () => {
    it("schedules at most one RAF per burst of scheduleUpdate calls", () => {
      const { env, flush } = makeEnv();
      const ref = makeRef(defaultRect);

      attachWebviewPositionSync(ref, updatePosition, 200, env);

      // Interval fires three times before the frame is flushed.
      flush.interval();
      flush.interval();
      flush.interval();

      expect(env.requestAnimationFrame).toHaveBeenCalledTimes(1);

      flush.frames();
      expect(updatePosition).toHaveBeenCalledTimes(1);
    });
  });

  describe("change detection", () => {
    it("does not call updatePosition again when rect has not changed", () => {
      const { env, flush } = makeEnv();
      const ref = makeRef(defaultRect);

      attachWebviewPositionSync(ref, updatePosition, 200, env);
      flush.frames(); // first call — rect differs from zero
      expect(updatePosition).toHaveBeenCalledTimes(1);

      flush.interval(); // schedule another RAF with same rect
      flush.frames();
      expect(updatePosition).toHaveBeenCalledTimes(1); // no additional call
    });

    it("calls updatePosition again when rect changes between polls", () => {
      const { env, flush } = makeEnv();
      let left = 10;
      const el = {
        getBoundingClientRect: () => ({
          left,
          top: 20,
          width: 300,
          height: 400,
        }),
      } as unknown as HTMLElement;
      const ref = { current: el };

      attachWebviewPositionSync(ref, updatePosition, 200, env);
      flush.frames();
      expect(updatePosition).toHaveBeenCalledTimes(1);

      left = 50; // element moved
      flush.interval();
      flush.frames();
      expect(updatePosition).toHaveBeenCalledTimes(2);
    });
  });

  describe("event-driven updates", () => {
    it("schedules an update on resize events", () => {
      const { env, flush } = makeEnv();
      const ref = makeRef(defaultRect);

      attachWebviewPositionSync(ref, updatePosition, 200, env);
      flush.frames(); // initial
      updatePosition.mockClear();

      const left = 50;
      (
        ref.current as unknown as { getBoundingClientRect: () => object }
      ).getBoundingClientRect = () => ({
        left,
        top: 20,
        width: 300,
        height: 400,
      });

      flush.event("resize");
      flush.frames();
      expect(updatePosition).toHaveBeenCalledTimes(1);
    });

    it("schedules an update on scroll events", () => {
      const { env, flush } = makeEnv();
      const ref = makeRef(defaultRect);

      attachWebviewPositionSync(ref, updatePosition, 200, env);
      flush.frames(); // initial
      updatePosition.mockClear();

      const top = 80;
      (
        ref.current as unknown as { getBoundingClientRect: () => object }
      ).getBoundingClientRect = () => ({
        left: 10,
        top,
        width: 300,
        height: 400,
      });

      flush.event("scroll");
      flush.frames();
      expect(updatePosition).toHaveBeenCalledTimes(1);
    });
  });

  describe("polling interval", () => {
    it("registers setInterval when pollInterval > 0", () => {
      const { env } = makeEnv();
      const ref = makeRef(defaultRect);

      attachWebviewPositionSync(ref, updatePosition, 200, env);
      expect(env.setInterval).toHaveBeenCalledWith(expect.any(Function), 200);
    });

    it("does not register setInterval when pollInterval is 0", () => {
      const { env } = makeEnv();
      const ref = makeRef(defaultRect);

      attachWebviewPositionSync(ref, updatePosition, 0, env);
      expect(env.setInterval).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("removes resize and scroll listeners on cleanup", () => {
      const { env } = makeEnv();
      const ref = makeRef(defaultRect);

      const cleanup = attachWebviewPositionSync(ref, updatePosition, 200, env);
      cleanup();

      expect(env.removeEventListener).toHaveBeenCalledWith(
        "resize",
        expect.any(Function)
      );
      expect(env.removeEventListener).toHaveBeenCalledWith(
        "scroll",
        expect.any(Function),
        true
      );
    });

    it("cancels a pending RAF on cleanup", () => {
      const { env } = makeEnv();
      const ref = makeRef(defaultRect);

      const cleanup = attachWebviewPositionSync(ref, updatePosition, 200, env);
      // Do NOT flush frames — the RAF is still pending.
      cleanup();

      expect(env.cancelAnimationFrame).toHaveBeenCalled();
    });

    it("clears the interval on cleanup", () => {
      const { env } = makeEnv();
      const ref = makeRef(defaultRect);

      const cleanup = attachWebviewPositionSync(ref, updatePosition, 200, env);
      cleanup();

      expect(env.clearInterval).toHaveBeenCalled();
    });

    it("does not clear interval when pollInterval is 0", () => {
      const { env } = makeEnv();
      const ref = makeRef(defaultRect);

      const cleanup = attachWebviewPositionSync(ref, updatePosition, 0, env);
      cleanup();

      expect(env.clearInterval).not.toHaveBeenCalled();
    });

    it("does not call updatePosition after cleanup", () => {
      const { env, flush } = makeEnv();
      const ref = makeRef(defaultRect);

      const cleanup = attachWebviewPositionSync(ref, updatePosition, 200, env);
      cleanup();

      // Flushing frames after cleanup should not invoke updatePosition because
      // the RAF was cancelled.
      flush.frames();
      expect(updatePosition).not.toHaveBeenCalled();
    });
  });

  describe("listener registration", () => {
    it("registers resize and scroll (capture) listeners on attach", () => {
      const { env } = makeEnv();
      const ref = makeRef(defaultRect);

      attachWebviewPositionSync(ref, updatePosition, 200, env);

      expect(env.addEventListener).toHaveBeenCalledWith(
        "resize",
        expect.any(Function)
      );
      expect(env.addEventListener).toHaveBeenCalledWith(
        "scroll",
        expect.any(Function),
        true
      );
    });
  });
});
