import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCache,
  getCacheStats,
  getCached,
  setCached,
} from "./localStorage";

const backing = new Map<string, string>();

beforeEach(() => {
  backing.clear();
  clearCache();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => backing.set(key, value),
    removeItem: (key: string) => backing.delete(key),
  });
});

describe("localStorage mirror bounds", () => {
  it("uses an LRU entry bound without deleting durable values", () => {
    for (let index = 0; index < 300; index += 1) {
      setCached(`key-${index}`, `value-${index}`);
    }

    expect(getCacheStats().size).toBeLessThanOrEqual(256);
    expect(backing.size).toBe(300);
    expect(getCached("key-0")).toBe("value-0");
    expect(getCacheStats().size).toBeLessThanOrEqual(256);
  });

  it("does not mirror a value larger than the per-entry budget", () => {
    const largeValue = "x".repeat(600_000);
    setCached("large", largeValue);

    expect(backing.get("large")).toBe(largeValue);
    expect(getCacheStats().keys).not.toContain("large");
  });
});
