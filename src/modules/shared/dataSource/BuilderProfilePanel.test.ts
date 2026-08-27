// @vitest-environment jsdom
import { act, createElement, useState } from "react";
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
    // HighlightCards formats numbers, dates and clock time per locale.
    i18n: { language: "en" },
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
  default: ({
    children,
    onClick,
    "data-testid": dataTestId,
  }: {
    children?: unknown;
    onClick?: () => void;
    "data-testid"?: string;
  }) =>
    createElement(
      "button",
      { onClick, "data-testid": dataTestId },
      children as never
    ),
}));

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children, content }: { children?: unknown; content?: string }) =>
    createElement("span", { title: content }, children as never),
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: ({ variant, title }: { variant: string; title?: string }) =>
    createElement("div", { "data-testid": `placeholder-${variant}` }, title),
  CollapsibleSection: ({
    title,
    children,
    defaultOpen = true,
    onOpenChange,
    titleButtonTestId,
  }: {
    title?: string;
    children?: unknown;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    titleButtonTestId?: string;
  }) => {
    const [open, setOpen] = useState(defaultOpen);
    return createElement(
      "section",
      null,
      createElement(
        "button",
        {
          "data-testid": titleButtonTestId,
          onClick: () =>
            setOpen((current) => {
              onOpenChange?.(!current);
              return !current;
            }),
        },
        title ?? ""
      ),
      open ? (children as never) : null
    );
  },
  PANEL_HEADER_TOKENS: {
    actionButton: {
      variant: "tertiary",
      size: "mini",
      shape: "circle",
      iconOnly: true,
    },
    buttonIconSize: 16,
    iconStrokeWidth: 1.75,
  },
  STAT_GRID_TOKENS: { cols3: "", cols4: "" },
}));

vi.mock("@src/components/Placeholder", () => ({
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
    bySourceCount: 0,
    bySource: [],
    driftCount: 0,
    drift: [],
    highlights: [
      {
        id: "longest_session",
        detailId: "longest_session",
        kind: "extreme" as const,
        params: { seconds: 53_700 },
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
    expect(
      container.querySelector('[data-testid="builder-type-avatar-EAWH"]')
    ).not.toBeNull();
  });

  it("opens the type gallery as a second layer beside Refresh", async () => {
    api.overview.mockResolvedValue(overview());
    await mount();

    const refresh = container.querySelector(
      '[data-testid="builder-profile-refresh"]'
    );
    const knowMore = container.querySelector<HTMLButtonElement>(
      '[data-testid="builder-profile-know-more"]'
    );
    const scrollRegion = container.querySelector(
      '[data-testid="builder-profile-scroll-region"]'
    );
    expect(scrollRegion?.contains(refresh)).toBe(true);
    expect(scrollRegion?.contains(knowMore)).toBe(true);
    expect(refresh?.nextElementSibling).toBe(knowMore);

    act(() => knowMore?.click());
    expect(
      container.querySelector('[data-testid="builder-types-gallery"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="builder-profile-refresh"]')
    ).toBeNull();

    const back = container.querySelector<HTMLButtonElement>(
      '[data-testid="builder-types-back"]'
    );
    act(() => back?.click());

    expect(
      container.querySelector('[data-testid="builder-profile-refresh"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="builder-type-detail"]')
        ?.textContent
    ).toContain("EAWH");
  });

  it("loads per-tool and over-time rows only after first expansion", async () => {
    const bySource = [
      {
        source: "codex",
        sessions: 240,
        code: "EAWH",
        confidence: 0.8,
        scores: [],
      },
      {
        source: "claude",
        sessions: 154,
        code: "EAFH",
        confidence: 0.7,
        scores: [],
      },
    ];
    const drift = [
      {
        startedAtMs: 1,
        endedAtMs: 2,
        sessions: 400,
        code: "EAWH",
        scores: [],
      },
      {
        startedAtMs: 3,
        endedAtMs: 4,
        sessions: 400,
        code: "EAWS",
        scores: [],
      },
    ];
    api.overview.mockImplementation(
      (
        _scope: unknown,
        options: { includeBySource?: boolean; includeDrift?: boolean }
      ) =>
        Promise.resolve(
          overview({
            bySourceCount: 2,
            bySource: options.includeBySource ? bySource : [],
            driftCount: 2,
            drift: options.includeDrift ? drift : [],
          })
        )
    );

    await mount();

    const byToolToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="profile-section-byTool"]'
    );
    const overTimeToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="profile-section-overTime"]'
    );
    expect(byToolToggle).not.toBeNull();
    expect(overTimeToggle).not.toBeNull();
    expect(container.querySelectorAll("table")).toHaveLength(0);
    expect(api.overview).toHaveBeenNthCalledWith(
      1,
      {},
      { includeBySource: false, includeDrift: false }
    );

    await act(async () => {
      byToolToggle?.click();
      await Promise.resolve();
    });

    expect(api.overview).toHaveBeenNthCalledWith(
      2,
      {},
      { includeBySource: true, includeDrift: false }
    );
    expect(
      byToolToggle?.closest("section")?.querySelector("table")
    ).not.toBeNull();

    act(() => byToolToggle?.click());
    act(() => byToolToggle?.click());
    expect(api.overview).toHaveBeenCalledTimes(2);

    await act(async () => {
      overTimeToggle?.click();
      await Promise.resolve();
    });

    expect(api.overview).toHaveBeenNthCalledWith(
      3,
      {},
      { includeBySource: true, includeDrift: true }
    );
    expect(
      overTimeToggle?.closest("section")?.querySelector("table")
    ).not.toBeNull();
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
    expect(
      container.querySelector('[data-testid="builder-type-avatar-EAWH"]')
        ?.className
    ).toContain("grayscale");
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
    // The mocked `t` echoes key:values, so this asserts the card reaches for
    // its three locale keys rather than carrying prose from the backend.
    expect(card?.textContent).toContain("cards.longest_session.question");
    expect(card?.textContent).toContain("cards.longest_session.headline");
    expect(card?.textContent).toContain("cards.longest_session.detail");
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
