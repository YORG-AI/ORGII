import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RulesMemoryEvolutionTable } from "./RulesMemoryEvolutionTable";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/components/Button", () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    createElement("button", null, children),
}));
vi.mock("@src/components/SettingsTable", () => ({
  default: () => createElement("div", { "data-testid": "rules-table" }),
  SETTINGS_TABLE_CELL: { primary: "", muted: "" },
  SETTINGS_TABLE_COL: { fill: "", valueLg: "" },
}));
vi.mock("@src/components/Switch", () => ({
  default: () => createElement("div"),
}));
vi.mock("@src/config/modelTable", () => ({ MODEL_TABLE_SWITCH_SIZE: "small" }));
vi.mock("@src/icons", () => ({
  Add01Icon: "add",
  Delete02Icon: "delete",
  Pen01Icon: "pen",
  HugeiconsIcon: () => createElement("svg"),
}));
vi.mock("@src/modules/MainApp/Settings/sections/SecuritySection", () => ({
  default: () => createElement("div", { "data-testid": "security" }),
}));
vi.mock("@src/modules/shared/layouts/blocks", () => ({
  DETAIL_PANEL_TOKENS: {
    headerWidth: "",
    scrollContentNoTop: "",
    contentWidthWithPaddingNoTop: "",
  },
  DetailPanelContainer: ({ children }: { children: React.ReactNode }) =>
    createElement("div", null, children),
  InlineInfoCard: ({ children }: { children: React.ReactNode }) =>
    createElement("div", null, children),
  InternalHeader: ({ tabs }: { tabs: React.ReactNode }) =>
    createElement("header", null, tabs),
  ScrollPreservation: ({ children }: { children: React.ReactNode }) =>
    createElement("main", null, children),
}));
vi.mock("@src/modules/shared/layouts/blocks/InfoRow", () => ({
  InfoRow: () => createElement("div"),
}));
vi.mock("@src/util/ui/openFileInWorkStation", () => ({
  openFileInWorkStation: vi.fn(),
}));
vi.mock("../../KeyVault/shared/InlineCardPrimitives", () => ({
  InlineCardColumnStack: ({ children }: { children: React.ReactNode }) =>
    createElement("div", null, children),
  InlineCardSplit: () => createElement("div"),
}));
vi.mock("../Evolution/AgentEvolutionPanel", () => ({
  default: () => createElement("div"),
}));
vi.mock("../Memory/WorkspaceMemoryBrowser", () => ({
  default: () => createElement("div"),
}));
vi.mock("./InlineExternalRulesImport", () => ({
  default: () => createElement("div"),
}));

describe("RulesMemoryEvolutionTable", () => {
  it("adds Security as the fourth page tab", () => {
    const markup = renderToStaticMarkup(
      createElement(RulesMemoryEvolutionTable, {
        markdownRules: [],
        loading: false,
        onSelectMarkdownRule: vi.fn(),
        onAdd: vi.fn(),
      })
    );

    const rules = markup.indexOf('data-tab-key="rules"');
    const memory = markup.indexOf('data-tab-key="memory"');
    const evolution = markup.indexOf('data-tab-key="evolution"');
    const security = markup.indexOf('data-tab-key="security"');

    expect(rules).toBeGreaterThanOrEqual(0);
    expect(memory).toBeGreaterThan(rules);
    expect(evolution).toBeGreaterThan(memory);
    expect(security).toBeGreaterThan(evolution);
  });
});
