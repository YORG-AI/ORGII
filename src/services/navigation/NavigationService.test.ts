import { beforeEach, describe, expect, it } from "vitest";

import { NavigationService } from "./NavigationService";

describe("NavigationService history bounds", () => {
  beforeEach(() => NavigationService.clearHistory());

  it("keeps only the newest 100 locations", () => {
    for (let index = 0; index < 150; index += 1) {
      NavigationService.pushLocation({
        filePath: `file-${index}.ts`,
        line: index,
        column: 0,
      });
    }

    const history = NavigationService.getHistory();
    expect(history.locations).toHaveLength(100);
    expect(history.locations[0].filePath).toBe("file-50.ts");
    expect(history.locations.at(-1)?.filePath).toBe("file-149.ts");
    expect(history.index).toBe(99);
  });
});
