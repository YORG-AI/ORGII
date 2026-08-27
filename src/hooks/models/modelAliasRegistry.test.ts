/**
 * Unit tests for the modelAliasRegistry pure functions.
 *
 * Covers:
 *   - replaceModelAliasesFromKeys populates icon and display-name maps
 *   - getModelAliasIcon / getModelAliasDisplayName lookups
 *   - replace clears stale entries
 *   - entries with missing alias are skipped
 *   - display_name / displayName fallback priority
 *   - whitespace-only display names are skipped
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getModelAliasDisplayName,
  getModelAliasIcon,
  replaceModelAliasesFromKeys,
} from "./modelAliasRegistry";

beforeEach(() => {
  replaceModelAliasesFromKeys([]);
});

afterEach(() => {
  replaceModelAliasesFromKeys([]);
});

describe("replaceModelAliasesFromKeys — basic population", () => {
  it("stores icon and display_name for each alias", () => {
    replaceModelAliasesFromKeys([
      {
        model_aliases: [
          { alias: "gpt-x", icon: "openai", display_name: "GPT X" },
        ],
      },
    ]);

    expect(getModelAliasIcon("gpt-x")).toBe("openai");
    expect(getModelAliasDisplayName("gpt-x")).toBe("GPT X");
  });

  it("handles multiple keys and multiple aliases per key", () => {
    replaceModelAliasesFromKeys([
      {
        model_aliases: [
          { alias: "claude-a", icon: "anthropic", display_name: "Claude A" },
          { alias: "claude-b", icon: "anthropic", display_name: "Claude B" },
        ],
      },
      {
        model_aliases: [
          { alias: "gemini-1", icon: "google", display_name: "Gemini 1" },
        ],
      },
    ]);

    expect(getModelAliasIcon("claude-a")).toBe("anthropic");
    expect(getModelAliasDisplayName("claude-b")).toBe("Claude B");
    expect(getModelAliasIcon("gemini-1")).toBe("google");
  });
});

describe("replaceModelAliasesFromKeys — clearing stale entries", () => {
  it("clears previously registered entries on a subsequent replace call", () => {
    replaceModelAliasesFromKeys([
      {
        model_aliases: [
          { alias: "old-model", icon: "openai", display_name: "Old Model" },
        ],
      },
    ]);

    expect(getModelAliasIcon("old-model")).toBe("openai");

    replaceModelAliasesFromKeys([
      {
        model_aliases: [
          { alias: "new-model", icon: "anthropic", display_name: "New Model" },
        ],
      },
    ]);

    expect(getModelAliasIcon("old-model")).toBeUndefined();
    expect(getModelAliasDisplayName("old-model")).toBeUndefined();
    expect(getModelAliasIcon("new-model")).toBe("anthropic");
  });

  it("results in empty maps after replace with empty array", () => {
    replaceModelAliasesFromKeys([
      {
        model_aliases: [
          { alias: "some-model", icon: "openai", display_name: "Some Model" },
        ],
      },
    ]);

    replaceModelAliasesFromKeys([]);

    expect(getModelAliasIcon("some-model")).toBeUndefined();
    expect(getModelAliasDisplayName("some-model")).toBeUndefined();
  });
});

describe("replaceModelAliasesFromKeys — skipping invalid entries", () => {
  it("skips entries without an alias", () => {
    replaceModelAliasesFromKeys([
      {
        model_aliases: [
          { alias: null, icon: "openai", display_name: "No Alias" },
          { alias: undefined, icon: "openai", display_name: "Undefined Alias" },
          { icon: "openai", display_name: "Missing Alias Key" },
        ],
      },
    ]);

    // No entries should be present in the maps
    // (we have no alias to look up, so just verify no errors and empty)
    expect(getModelAliasIcon("null")).toBeUndefined();
  });

  it("stores icon but omits display_name when display_name is missing", () => {
    replaceModelAliasesFromKeys([
      {
        model_aliases: [{ alias: "icon-only", icon: "openai" }],
      },
    ]);

    expect(getModelAliasIcon("icon-only")).toBe("openai");
    expect(getModelAliasDisplayName("icon-only")).toBeUndefined();
  });

  it("skips display_name when it is whitespace-only", () => {
    replaceModelAliasesFromKeys([
      {
        model_aliases: [
          { alias: "ws-model", icon: "openai", display_name: "   " },
        ],
      },
    ]);

    expect(getModelAliasDisplayName("ws-model")).toBeUndefined();
  });

  it("stores icon even when display_name is absent", () => {
    replaceModelAliasesFromKeys([
      {
        model_aliases: [
          { alias: "icon-no-name", icon: "anthropic", display_name: null },
        ],
      },
    ]);

    expect(getModelAliasIcon("icon-no-name")).toBe("anthropic");
    expect(getModelAliasDisplayName("icon-no-name")).toBeUndefined();
  });
});

describe("replaceModelAliasesFromKeys — displayName fallback", () => {
  it("uses displayName (camelCase) when display_name is absent", () => {
    replaceModelAliasesFromKeys([
      {
        model_aliases: [
          { alias: "camel-model", icon: "openai", displayName: "Camel Model" },
        ],
      },
    ]);

    expect(getModelAliasDisplayName("camel-model")).toBe("Camel Model");
  });

  it("prefers display_name over displayName when both are present", () => {
    replaceModelAliasesFromKeys([
      {
        model_aliases: [
          {
            alias: "both-names",
            icon: "openai",
            display_name: "Snake Name",
            displayName: "Camel Name",
          },
        ],
      },
    ]);

    expect(getModelAliasDisplayName("both-names")).toBe("Snake Name");
  });
});

describe("getModelAliasIcon / getModelAliasDisplayName — unknown keys", () => {
  it("returns undefined for a key not in the registry", () => {
    expect(getModelAliasIcon("does-not-exist")).toBeUndefined();
    expect(getModelAliasDisplayName("does-not-exist")).toBeUndefined();
  });
});
