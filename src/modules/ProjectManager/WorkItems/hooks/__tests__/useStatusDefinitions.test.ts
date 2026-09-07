import { describe, expect, it } from "vitest";

import type { StatusDefinition } from "@src/api/http/project";

import {
  getSelectableStatusDefinitions,
  resolveStatusCategory,
  statusDefinitionToOption,
} from "../useStatusDefinitions";

const definition = (
  key: string,
  category: StatusDefinition["category"],
  color?: string
): StatusDefinition => ({
  id: `wis_${key}`,
  orgId: "personal-org",
  key,
  name: key,
  category,
  color: color ?? null,
  description: null,
  position: 0,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
});

describe("useStatusDefinitions helpers", () => {
  it("resolves custom keys to their category and passes builtins through", () => {
    const definitions = [definition("shipping", "completed")];
    expect(resolveStatusCategory("shipping", definitions)).toBe("completed");
    expect(resolveStatusCategory("in_progress", definitions)).toBe(
      "in_progress"
    );
    expect(resolveStatusCategory("unknown", definitions)).toBe("unknown");
  });

  it("maps a definition to a dropdown option with its color", () => {
    const option = statusDefinitionToOption(
      definition("shipping", "completed", "#22c55e")
    );
    expect(option.value).toBe("shipping");
    expect(option.label).toBe("shipping");
    expect(option.color).toBe("#22c55e");
  });

  it("falls back to the category color when none is set", () => {
    const option = statusDefinitionToOption(definition("later", "backlog"));
    expect(option.color).toBeTruthy();
  });

  it("keeps archived definitions for resolution but excludes them from selection", () => {
    const archived = {
      ...definition("waiting", "blocked"),
      archivedAt: 42,
    };

    expect(resolveStatusCategory("waiting", [archived])).toBe("blocked");
    expect(getSelectableStatusDefinitions([archived])).toEqual([]);
  });
});
