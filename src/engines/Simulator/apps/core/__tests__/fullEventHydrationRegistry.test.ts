import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  clearHydratedEvents,
  getHydratedEventStats,
  hydrateFullEventWindow,
} from "../fullEventHydrationRegistry";

const event = (id: string) =>
  ({ id, result: { text: "x".repeat(1000) } }) as unknown as SessionEvent;
afterEach(() => {
  clearHydratedEvents();
  vi.unstubAllGlobals();
});
describe("replay diagnostic ownership", () => {
  it("does not own payloads after weak references expire", () => {
    let alive = true;
    vi.stubGlobal(
      "WeakRef",
      class {
        constructor(private value: SessionEvent) {}
        deref() {
          return alive ? this.value : undefined;
        }
      }
    );
    const events = [event("one")];
    expect(hydrateFullEventWindow(events)).toEqual(events);
    expect(getHydratedEventStats().entries).toBe(1);
    alive = false;
    expect(getHydratedEventStats()).toEqual({ entries: 0, bytes: 0 });
    expect(events[0].result).toBeDefined();
  });
  it("bounds diagnostic metadata and deduplicates repeated event identities", () => {
    const events = Array.from({ length: 700 }, (_, i) => event(String(i)));
    hydrateFullEventWindow(events);
    expect(getHydratedEventStats().entries).toBe(600);
    hydrateFullEventWindow(events.slice(-20));
    expect(getHydratedEventStats().entries).toBe(600);
    clearHydratedEvents();
    expect(events).toHaveLength(700);
  });
  it("keeps replay usable on runtimes without WeakRef", () => {
    vi.stubGlobal("WeakRef", undefined);
    const events = [event("one")];
    expect(hydrateFullEventWindow(events)).toEqual(events);
    expect(getHydratedEventStats().entries).toBe(0);
  });
});
