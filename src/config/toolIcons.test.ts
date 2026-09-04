import { afterEach, describe, expect, it } from "vitest";

import {
  _resetToolRegistry,
  _setBuiltinIconIdMap,
} from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { BookOpen02Icon, Search01Icon, Wrench01Icon } from "@src/icons";

import { getEventIconComponent, getToolIconComponent } from "./toolIcons";

afterEach(() => {
  _resetToolRegistry();
});

describe("read-file icons", () => {
  it("resolves the read-file tool and event metadata to BookOpen02Icon", () => {
    _setBuiltinIconIdMap(new Map([["read_file", "book-open-02"]]));

    expect(getToolIconComponent("read_file")).toBe(BookOpen02Icon);
    expect(getEventIconComponent("read_file")).toBe(BookOpen02Icon);
  });

  it("keeps common builtin icons available before init_tool_registry runs", () => {
    _resetToolRegistry();

    expect(getToolIconComponent("read_file")).toBe(BookOpen02Icon);
    expect(getToolIconComponent("code_search")).toBe(Search01Icon);
    expect(getToolIconComponent("grep")).toBe(Search01Icon);
    expect(getToolIconComponent("tool")).toBe(Wrench01Icon);
  });
});
