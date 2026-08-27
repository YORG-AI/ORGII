import { describe, expect, it } from "vitest";

import { isCliUpdateAlertSuppressed } from "../cliUpdateAlertsAtom";

describe("CLI update alert suppressions", () => {
  it("snoozes only until the stored deadline", () => {
    const suppression = { snoozedUntil: 10_000 };

    expect(isCliUpdateAlertSuppressed(suppression, "0.2.0", 9_999)).toBe(true);
    expect(isCliUpdateAlertSuppressed(suppression, "0.2.0", 10_000)).toBe(
      false
    );
  });

  it("mutes the advertised version but not the next version", () => {
    const suppression = { mutedLatestVersion: "0.2.0" };

    expect(isCliUpdateAlertSuppressed(suppression, "0.2.0", 0)).toBe(true);
    expect(isCliUpdateAlertSuppressed(suppression, "0.3.0", 0)).toBe(false);
    expect(isCliUpdateAlertSuppressed(suppression, null, 0)).toBe(false);
  });
});
