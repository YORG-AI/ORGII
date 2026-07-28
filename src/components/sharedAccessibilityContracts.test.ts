import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function componentSource(path: string): string {
  return readFileSync(resolve(__dirname, path), "utf8");
}

describe("shared component accessibility contracts", () => {
  it("uses native buttons for date-range and window controls", () => {
    const dateRange = componentSource("DateRangeSelector/index.tsx");
    const trafficLights = componentSource("TrafficLights/index.tsx");

    expect(dateRange).toMatch(
      /<button\s+type="button"[\s\S]*?aria-haspopup="dialog"[\s\S]*?aria-expanded=\{isOpen\}/
    );
    expect(trafficLights.match(/<button/g)).toHaveLength(3);
    expect(trafficLights).toContain("disabled={disableMaximize}");
  });

  it("keeps image preview dismissal keyboard and screen-reader accessible", () => {
    const image = componentSource("Image/index.tsx");

    expect(image).toContain('event.key === "Escape"');
    expect(image).toContain('document.addEventListener("keydown"');
    expect(image).toContain('role="dialog"');
    expect(image).toContain("aria-modal={true}");
    expect(image).toContain('aria-label="Close preview"');
  });

  it("exposes keyboard semantics for search expansion and virtual rows", () => {
    const searchInput = componentSource("SearchInput/index.tsx");
    const virtualizedSessions = componentSource(
      "Virtualized/VirtualizedSessionList.tsx"
    );

    expect(searchInput).toMatch(
      /<button[\s\S]*?onClick=\{onExpandToggle\}[\s\S]*?aria-expanded=\{expanded\}/
    );
    expect(virtualizedSessions).toContain('role="button"');
    expect(virtualizedSessions).toContain("tabIndex={0}");
    expect(virtualizedSessions).toContain(
      'event.key === "Enter" || event.key === " "'
    );
  });
});
