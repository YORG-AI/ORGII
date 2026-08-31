import { describe, expect, it } from "vitest";

import {
  WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE,
  WORKSTATION_TRAIL_WIDTH_VARIABLE,
  resolveTrailWidthVariables,
} from "./trailWidth";

describe("fixed trail and resizable terminal column", () => {
  it("keeps the fixed trail inside the column inset", () => {
    expect(resolveTrailWidthVariables()).toEqual({
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: "248px",
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: "256px",
    });
  });

  it("widens only the column when opening the terminal", () => {
    expect(resolveTrailWidthVariables({ terminalShown: true })).toEqual({
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: "248px",
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: "408px",
    });
  });

  it("reserves the terminal's resized width without changing the trail", () => {
    expect(
      resolveTrailWidthVariables({ terminalShown: true, terminalWidth: 610 })
    ).toEqual({
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: "248px",
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: "618px",
    });
    expect(
      resolveTrailWidthVariables({ terminalShown: true, terminalWidth: 220 })
    ).toEqual({
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: "248px",
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: "256px",
    });
  });

  it("releases the terminal's extra width when folded or hidden", () => {
    expect(
      resolveTrailWidthVariables({ terminalShown: false, terminalWidth: 610 })
    ).toEqual({
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: "248px",
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: "256px",
    });
  });

  it("lets the collapsed rail's fixed class own the column", () => {
    expect(
      resolveTrailWidthVariables({
        collapsed: true,
        terminalShown: true,
        terminalWidth: 610,
      })
    ).toEqual({
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: "100%",
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: "100%",
    });
  });
});
