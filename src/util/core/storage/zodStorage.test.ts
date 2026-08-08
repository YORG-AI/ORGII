import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { createZodJsonStorage, tolerantRecordSchema } from "./zodStorage";

const ListSchema = z.array(z.string());

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("createZodJsonStorage", () => {
  it("degrades a failed persist to onWriteError instead of throwing", () => {
    const onWriteError = vi.fn();
    const storage = createZodJsonStorage(ListSchema, { onWriteError });
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => storage.setItem("k", ["a"])).not.toThrow();
    expect(onWriteError).toHaveBeenCalledWith("k", expect.anything());
    setItem.mockRestore();
  });

  it("subscribe resyncs from another window's storage event", () => {
    // The stubbed test window does not deliver dispatched events, so capture
    // the registered handler and drive it with StorageEvent-shaped objects.
    const listeners: EventListener[] = [];
    const addSpy = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type, listener) => {
        if (type === "storage") listeners.push(listener as EventListener);
      });
    const removeSpy = vi
      .spyOn(window, "removeEventListener")
      .mockImplementation(() => {});

    const storage = createZodJsonStorage(ListSchema);
    const seen: string[][] = [];
    const unsubscribe = storage.subscribe("k", (value) => seen.push(value), []);
    expect(listeners).toHaveLength(1);
    const emit = (key: string, newValue: string | null) =>
      listeners[0]?.({
        key,
        newValue,
        storageArea: localStorage,
      } as unknown as Event);

    emit("k", JSON.stringify(["from-other-window"]));
    expect(seen).toEqual([["from-other-window"]]);
    // Removal in the other window resets to the initial value.
    emit("k", null);
    expect(seen).toEqual([["from-other-window"], []]);
    // Unrelated keys and invalid payloads never surface raw.
    emit("other", JSON.stringify(["x"]));
    emit("k", "{not json");
    expect(seen).toEqual([["from-other-window"], [], []]);

    unsubscribe();
    expect(removeSpy).toHaveBeenCalledWith("storage", listeners[0]);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});

describe("tolerantRecordSchema", () => {
  it("drops only invalid entries and keeps the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = tolerantRecordSchema("thing", z.object({ n: z.number() }));
    expect(
      schema.parse({
        good: { n: 1 },
        wrongShape: { n: "nope" },
        notAnObject: "garbage",
        alsoGood: { n: 2 },
      })
    ).toEqual({ good: { n: 1 }, alsoGood: { n: 2 } });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("parses an empty record and still fails non-record roots", () => {
    const schema = tolerantRecordSchema("thing", z.string());
    expect(schema.parse({})).toEqual({});
    // A non-record root is unrecoverable garbage: the whole-store initial
    // value fallback in createZodJsonStorage is the right behavior there.
    expect(schema.safeParse("not-a-record").success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it("composes through createZodJsonStorage so one bad entry never resets the store", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = createZodJsonStorage(
      tolerantRecordSchema("token list", z.array(z.string()))
    );
    localStorage.setItem(
      "tags",
      JSON.stringify({ keep: ["cloud:org-1"], drop: 42 })
    );
    expect(storage.getItem("tags", {})).toEqual({ keep: ["cloud:org-1"] });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
