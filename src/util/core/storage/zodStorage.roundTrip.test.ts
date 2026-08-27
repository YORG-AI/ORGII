import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { createZodJsonStorage } from "./zodStorage";

const storage = new Map<string, string>();

const localStorageMock: Storage = {
  get length() {
    return storage.size;
  },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => Array.from(storage.keys())[index] ?? null,
  removeItem: (key) => storage.delete(key),
  setItem: (key, value) => storage.set(key, value),
};

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

describe("createZodJsonStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns the initial value when the key is missing", () => {
    const storage = createZodJsonStorage(z.number());

    expect(storage.getItem("missing", 7)).toBe(7);
  });

  it("parses stored JSON through the schema", () => {
    localStorage.setItem("count", "42");
    const storage = createZodJsonStorage(z.number());

    expect(storage.getItem("count", 0)).toBe(42);
  });

  it("returns the initial value and reports invalid persisted data", () => {
    const onInvalid = vi.fn();
    localStorage.setItem("count", JSON.stringify("bad"));
    const storage = createZodJsonStorage(z.number(), { onInvalid });

    expect(storage.getItem("count", 0)).toBe(0);
    expect(onInvalid).toHaveBeenCalledWith(
      "count",
      JSON.stringify("bad"),
      expect.any(Error)
    );
  });

  it("can rewrite invalid values to the initial value", () => {
    localStorage.setItem("count", JSON.stringify("bad"));
    const storage = createZodJsonStorage(z.number(), {
      writeDefaultOnInvalid: true,
    });

    expect(storage.getItem("count", 3)).toBe(3);
    expect(localStorage.getItem("count")).toBe("3");
  });

  it("serializes values on set and removes values on remove", () => {
    const storage = createZodJsonStorage(z.object({ enabled: z.boolean() }));

    storage.setItem("state", { enabled: true });
    expect(localStorage.getItem("state")).toBe(
      JSON.stringify({ enabled: true })
    );

    storage.removeItem("state");
    expect(localStorage.getItem("state")).toBeNull();
  });
});
