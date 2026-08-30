import { describe, expect, it } from "vitest";

import {
  WORKSTATION_TRAIL_TERMINAL_WIDTH,
  WORKSTATION_TRAIL_TRACK_PADDING_X,
  WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE,
  WORKSTATION_TRAIL_WIDTH_LIMITS,
  WORKSTATION_TRAIL_WIDTH_VARIABLE,
  clampTrailWidth,
  resolveNextWiderTrailWidth,
  resolveTrailMinWidth,
  resolveTrailWidthVariables,
} from "./trailWidth";

const {
  default: DEFAULT_WIDTH,
  floor,
  max,
  step,
} = WORKSTATION_TRAIL_WIDTH_LIMITS;

describe("resolveTrailMinWidth", () => {
  it("falls back to the floor when nothing is stored", () => {
    expect(resolveTrailMinWidth(null)).toBe(floor);
    expect(resolveTrailMinWidth(Number.NaN)).toBe(floor);
  });

  it("keeps a user-set minimum wider than the shipped default", () => {
    // "Set current width as minimum" pins whatever the trail is at, which
    // may be a width the user dragged well past 256px.
    expect(resolveTrailMinWidth(DEFAULT_WIDTH + step)).toBe(
      DEFAULT_WIDTH + step
    );
  });

  it("clamps a stored minimum into the hard bounds", () => {
    expect(floor).toBe(220);
    expect(resolveTrailMinWidth(10)).toBe(floor);
    expect(resolveTrailMinWidth(max + 400)).toBe(max);
  });
});

describe("clampTrailWidth", () => {
  it("defaults to the shipped width when nothing is stored", () => {
    expect(clampTrailWidth(null, floor)).toBe(DEFAULT_WIDTH);
  });

  it("never returns a width below the user-set minimum", () => {
    expect(clampTrailWidth(200, 320)).toBe(320);
  });

  it("respects a minimum above the shipped default", () => {
    expect(clampTrailWidth(null, 400)).toBe(400);
  });

  it("caps at the maximum", () => {
    expect(clampTrailWidth(max + 100, floor)).toBe(max);
  });
});

describe("resolveNextWiderTrailWidth", () => {
  it("grows by one step", () => {
    expect(resolveNextWiderTrailWidth(DEFAULT_WIDTH, floor)).toBe(
      DEFAULT_WIDTH + step
    );
  });

  it("returns the same width at the maximum, so the menu can disable it", () => {
    expect(resolveNextWiderTrailWidth(max, floor)).toBe(max);
  });
});

describe("resolveTrailWidthVariables", () => {
  it("keeps the trail box inside the column's edge inset", () => {
    // The measured width is the *column*, the same thing the old `w-64`
    // track was, so the trail box inside it is one inset narrower and never
    // reaches the pane edge.
    expect(resolveTrailWidthVariables(288)).toEqual({
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: `${
        288 - WORKSTATION_TRAIL_TRACK_PADDING_X
      }px`,
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: "288px",
    });
  });

  it("reproduces the shipped track the trail had before it could resize", () => {
    expect(resolveTrailWidthVariables(DEFAULT_WIDTH)).toEqual({
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: "248px",
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: "256px",
    });
  });

  it("widens only the column when the terminal is the wider of the two", () => {
    // Opening the terminal must not resize the trail itself, and the
    // terminal still gets its full width inside the inset.
    expect(resolveTrailWidthVariables(256, { terminalShown: true })).toEqual({
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: "248px",
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: `${
        WORKSTATION_TRAIL_TERMINAL_WIDTH + WORKSTATION_TRAIL_TRACK_PADDING_X
      }px`,
    });
  });

  it("leaves a trail wider than the terminal owning the column", () => {
    const wide = WORKSTATION_TRAIL_TERMINAL_WIDTH + 60;
    expect(resolveTrailWidthVariables(wide, { terminalShown: true })).toEqual({
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: `${
        wide - WORKSTATION_TRAIL_TRACK_PADDING_X
      }px`,
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: `${wide}px`,
    });
  });

  it("lets the collapsed rail's own class own the column", () => {
    expect(
      resolveTrailWidthVariables(288, { collapsed: true, terminalShown: true })
    ).toEqual({
      [WORKSTATION_TRAIL_WIDTH_VARIABLE]: "100%",
      [WORKSTATION_TRAIL_TRACK_WIDTH_VARIABLE]: "100%",
    });
  });
});
