import { afterEach, describe, expect, it } from "vitest";

import {
  _resetToolRegistry,
  getAppSubtool,
  getAppTypeForTool,
  initBundledToolRegistry,
  resolveCliAlias,
} from "./initToolRegistry";

describe("initBundledToolRegistry", () => {
  afterEach(() => {
    _resetToolRegistry();
  });

  it("initializes the Web registry from bundled data without a desktop round trip", async () => {
    _resetToolRegistry();

    await initBundledToolRegistry();
    await initBundledToolRegistry();

    expect(resolveCliAlias("Read")?.storage).toBe("read_file");
    expect(getAppTypeForTool("read_file")).toBe("CODE_EDITOR");
    expect(getAppSubtool("web_search")).toBe("browser");
  });
});
