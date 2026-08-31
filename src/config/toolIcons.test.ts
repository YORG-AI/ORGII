import { afterEach, describe, expect, it } from "vitest";

import {
  _resetToolRegistry,
  _setBuiltinIconIdMap,
} from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { BookOpen02Icon } from "@src/icons";

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
});
