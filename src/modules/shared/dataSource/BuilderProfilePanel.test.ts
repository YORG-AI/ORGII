// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AxisScore,
  BuilderProfileOverview,
} from "@src/api/tauri/builderProfile";

import BuilderProfilePanel from "./BuilderProfilePanel";

const api = vi.hoisted(() => ({
  overview: vi.fn(),
  extract: vi.fn(),
}));

vi.mock("@src/api/tauri/builderProfile", () => ({
  builderProfileOverview: api.overview,
  builderProfileExtract: api.extract,
  AXIS_ORDER: ["ME", "DA", "FW", "SH"],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Echo interpolation so assertions can see the values that were passed.
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${Object.values(vars).join(",")}` : key,
  }),
}));

vi.mock("@src/hooks/ui", () => ({
  useRefreshSpin: (onRefresh: () => void) => ({
    spinClass: undefined,
    handleClick: onRefresh,
  }),
}));

vi.mock("@src/components/Button", () => ({
  default: ({ children }: { children?: unknown }) =>
    createElement("button", null, children as never),
}));

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children, content }: { children?: unknown; content?: string }) =>
    createElement("span", { title: content }, children as never),
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: ({ variant, title }: { variant: string; title?: string }) =>
    createElement("div", { "data-testid": `placeholder-${variant}` }, title),
}));

vi.mock("@src/modules/shared/layouts/SectionLayout", () => ({
  SECTION_GAP_CLASSES: "",
  SECTION_SUBHEADING_CLASSES: "",
  SectionContainer: ({ children }: { children?: unknown }) =>
    createElement("section", null, children as never),
  SectionRow: ({
    label,
    description,
    children,
  }: {
    label?: string;
    description?: string;
    children?: unknown;
  }) =>
    createElement(
      "div",
      null,
      label ?? "",
      description ?? "",
      children as never
    ),
  ExpandableTableRow: ({
    label,
    description,
    extraControls,
    children,
    expanded,
  }: {
    label?: string;
    description?: string;
    extraControls?: unknown;
    children?: unknown;
    expanded?: boolean;
  }) =>
    createElement(
      "div",
      null,
      label ?? "",
      description ?? "",
      extraControls as never,
      expanded ? (children as never) : null
    ),
}));

vi.mock("@src/components/ProgressBar", () => ({
  default: ({ percent }: { percent: number }) =>
    createElement("div", {
      "data-testid": "progress",
      "data-percent": percent,
    }),
}));

vi.mock("@src/components/SettingsTable", () => ({
  default: ({ rows }: { rows?: unknown[] }) =>
    createElement("table", { "data-rows": rows?.length ?? 0 }),
  SETTINGS_TABLE_CELL: { primary: "", value: "", muted: "" },
  SETTINGS_TABLE_COL: { fill: "", valueSm: "", valueMd: "" },
}));

function axis(over: Partial<AxisScore> = {}): AxisScore {
  return {
    key: "DA",
    question: "q",
    positiveName: "Delegate",
    negativeName: "Direct",
    score: 29,
    letter: "A",
    clarity: "clear" as const,
    sessions: 100,
    consistency: 0.84,
    stability: 0.4,
    flipFactor: 3.2,
    caveat: null,
    evidence: [],
    ...over,
  };
}

function overview(over: Partial<BuilderProfileOverview> = {}) {
  return {
    profile: {
      code: "EAWH",
      archetype: "Swarm Founder",
      blurbs: [],
      confidence: 0.48,
      sessions: 394,
      hasEnoughSessions: true,
      axes: [
        axis({ key: "ME", letter: "E" }),
        axis({ key: "DA", letter: "A" }),
        axis({ key: "FW", letter: "W" }),
        axis({ key: "SH", letter: "H" }),
      ],
      secondary: [],
      subagentSessionShare: 0.09,
      startedAtMs: 0,
      endedAtMs: 0,
    },
    bySource: [],
    drift: [],
    highlights: [
      {
        id: "longest_session",
        kind: "extreme" as const,
        question: "Your longest single session?",
        headline: "14h 55m",
        detail: "Your deepest uninterrupted stretch with an agent.",
      },
    ],
    coverage: { extracted: 394, known: 394, stale: 0, unreadable: 0 },
    ...over,
  } as BuilderProfileOverview;
}

let container: HTMLDivElement;
let root: Root;

async function mount() {
  await act(async () => {
    root.render(createElement(BuilderProfilePanel));
  });
  // let the extraction tick settle
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.extract.mockResolvedValue({
    extractedNow: 0,
    coverage: { extracted: 394, known: 394, stale: 0, unreadable: 0 },
    more: false,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BuilderProfilePanel", () => {
  it("shows the earned code and its archetype", async () => {
    api.overview.mockResolvedValue(overview());
    await mount();

    const code = container.querySelector(
      '[data-testid="builder-profile-code"]'
    );
    expect(code?.textContent).toBe("EAWH");
    expect(container.textContent).toContain("Swarm Founder");
  });

  it("always shows a letter, and says when it is only weakly held", async () => {
    const reason = "your sessions are split on this";
    api.overview.mockResolvedValue(
      overview({
        profile: {
          ...overview().profile,
          code: "EAWH",
          archetype: "Swarm Founder",
          axes: [
            axis({ key: "ME", letter: "E" }),
            axis({ key: "DA", letter: "A" }),
            // A coin flip on this axis: the letter still stands, softly.
            axis({
              key: "FW",
              letter: "W",
              clarity: "slight" as const,
              score: 2,
              caveat: reason,
            }),
            axis({ key: "SH", letter: "H" }),
          ],
        },
      })
    );
    await mount();

    const code = container.querySelector(
      '[data-testid="builder-profile-code"]'
    );
    // no "?" — a refusal is not a type
    expect(code?.textContent).toBe("EAWH");
    expect(code?.textContent).not.toContain("?");
    // the softness is disclosed rather than hidden behind a placeholder
    expect(container.innerHTML).toContain(reason);
  });

  it("warns instead of asserting a type on a thin corpus", async () => {
    const base = overview();
    api.overview.mockResolvedValue(
      overview({
        profile: { ...base.profile, sessions: 8, hasEnoughSessions: false },
      })
    );
    await mount();
    expect(container.textContent).toContain("tooFewSessions");
  });

  it("shows no letters at all before any session has been read", async () => {
    const base = overview();
    api.overview.mockResolvedValue(
      overview({
        profile: {
          ...base.profile,
          sessions: 0,
          hasEnoughSessions: false,
        },
      })
    );
    await mount();
    // A default code would present as a confident type over zero evidence.
    expect(
      container.querySelector('[data-testid="builder-profile-code"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="builder-profile-empty-code"]')
        ?.textContent
    ).toContain("noSessionsYet");
  });

  it("reports how much of the history has been read as a progress bar", async () => {
    api.overview.mockResolvedValue(
      overview({
        coverage: { extracted: 120, known: 900, stale: 0, unreadable: 0 },
      })
    );
    // The extract tick reports coverage too, and being fresher it wins.
    api.extract.mockResolvedValue({
      extractedNow: 0,
      coverage: { extracted: 120, known: 900, stale: 0, unreadable: 0 },
      more: true,
    });
    await mount();

    const region = container.querySelector(
      '[data-testid="builder-profile-coverage"]'
    );
    // 120 of 900 read
    expect(
      region
        ?.querySelector('[data-testid="progress"]')
        ?.getAttribute("data-percent")
    ).toBe("13");
    expect(region?.textContent).toContain("13%");
  });

  it("renders a highlight card as question, answer, and context", async () => {
    api.overview.mockResolvedValue(overview());
    await mount();

    const card = container.querySelector(
      '[data-testid="highlight-longest_session"]'
    );
    expect(card?.textContent).toContain("Your longest single session?");
    expect(card?.textContent).toContain("14h 55m");
    expect(card?.textContent).toContain("uninterrupted stretch");
  });

  it("stops extracting once the backlog is drained", async () => {
    api.overview.mockResolvedValue(overview());
    await mount();
    // `more: false` on the first batch must not schedule another one
    expect(api.extract).toHaveBeenCalledTimes(1);
  });

  it("surfaces a load failure instead of rendering an empty profile", async () => {
    api.overview.mockRejectedValue(new Error("db locked"));
    await mount();
    expect(
      container.querySelector('[data-testid="placeholder-error"]')?.textContent
    ).toContain("db locked");
  });
});
