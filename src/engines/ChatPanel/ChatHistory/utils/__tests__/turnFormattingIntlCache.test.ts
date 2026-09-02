import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("turn clock formatting", () => {
  it("shares one bounded Intl formatter across page and timing labels", async () => {
    vi.resetModules();
    const rawLocaleTimeSpy = vi.spyOn(Date.prototype, "toLocaleTimeString");
    const formatterConstructor = vi.spyOn(Intl, "DateTimeFormat");
    const [{ formatTurnPageTimeLabel }, { getTurnTimingLabels }] =
      await Promise.all([
        import("../turnPageFormatting"),
        import("../turnTimingFormatting"),
      ]);
    const startMs = Date.UTC(2026, 8, 2, 3, 0, 0);
    const endMs = startMs + 65_000;
    const metas = [
      {
        startMs,
        endMs,
      },
    ] as Parameters<typeof formatTurnPageTimeLabel>[0];

    const pageLabel = formatTurnPageTimeLabel(metas);
    const timing = getTurnTimingLabels(endMs - startMs, startMs, endMs);
    const constructorCountAfterFirstRender =
      formatterConstructor.mock.calls.length;
    formatTurnPageTimeLabel(metas);
    getTurnTimingLabels(endMs - startMs, startMs, endMs);

    expect(pageLabel).toBe(`${timing.startClock} ~ ${timing.endClock}`);
    expect(rawLocaleTimeSpy).not.toHaveBeenCalled();
    expect(constructorCountAfterFirstRender).toBeGreaterThan(0);
    expect(formatterConstructor).toHaveBeenCalledTimes(
      constructorCountAfterFirstRender
    );
  });
});
