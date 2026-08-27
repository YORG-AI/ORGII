import { describe, expect, it } from "vitest";

import type {
  DiagnosticHealthState,
  DiagnosticSourceInfo,
  DiagnosticSourceStatus,
} from "@src/store/workstation/codeEditor/diagnostics";

import { buildLanguageServicePanelRows } from "./languageServicePanelRows";

const t = (key: string) => key;

function source(status: DiagnosticSourceStatus): DiagnosticSourceInfo {
  return { status, lastUpdated: 0 };
}

function health(
  lsp: Array<[string, DiagnosticSourceStatus]>,
  eslint: DiagnosticSourceStatus | null = null
): DiagnosticHealthState {
  return {
    lsp: new Map(lsp.map(([lang, status]) => [lang, source(status)])),
    eslint: eslint ? source(eslint) : null,
    hasActiveSource: false,
  };
}

describe("buildLanguageServicePanelRows", () => {
  it("returns a single empty row when nothing is registered", () => {
    expect(buildLanguageServicePanelRows(health([]), t)).toEqual([
      {
        kind: "empty",
        key: "empty",
        message: "workstation.noLanguageServicesActive",
      },
    ]);
  });

  it("emits one LSP row per language with a translated status", () => {
    expect(
      buildLanguageServicePanelRows(health([["rust", "active"]]), t)
    ).toEqual([
      {
        kind: "pair",
        key: "lsp-rust",
        left: "LSP",
        right: "rust · common:status.connected",
        uiStatus: "active",
      },
    ]);
  });

  it("collapses language flavors onto their base language", () => {
    const rows = buildLanguageServicePanelRows(
      health([
        ["typescript", "initializing"],
        ["typescriptreact", "active"],
      ]),
      t
    );

    expect(rows).toEqual([
      {
        kind: "pair",
        key: "lsp-typescript",
        left: "LSP",
        right: "typescript · common:status.connected",
        uiStatus: "active",
      },
    ]);
  });

  it("appends an ESLint row after the LSP rows", () => {
    const rows = buildLanguageServicePanelRows(
      health([["json", "failed"]], "unavailable"),
      t
    );

    expect(rows).toEqual([
      {
        kind: "pair",
        key: "lsp-json",
        left: "LSP",
        right: "json · common:status.failed",
        uiStatus: "failed",
      },
      {
        kind: "pair",
        key: "eslint",
        left: "ESLint",
        right: "common:status.unavailable",
        uiStatus: "unknown",
      },
    ]);
  });

  it("does not fall back to the empty row when only ESLint is present", () => {
    const rows = buildLanguageServicePanelRows(health([], "initializing"), t);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "pair",
      key: "eslint",
      uiStatus: "initializing",
    });
  });
});
