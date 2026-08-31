// @vitest-environment jsdom
import type { TFunction } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SyncJournalEntry } from "@src/features/Org2Cloud/org2CloudSyncJournal";
import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

import {
  CloudOrgSyncSection,
  formatSyncJournalForCopy,
} from "./CloudOrgSyncSection";
import type { CloudOrgSyncStatus } from "./useCloudOrgSyncStatus";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const t = ((key: string, vars?: Record<string, unknown>) =>
  vars
    ? `${key}:${Object.values(vars).join(",")}`
    : key) as TFunction<"navigation">;

function status(
  overrides: Partial<CloudOrgSyncStatus> = {}
): CloudOrgSyncStatus {
  return {
    isOfficialEndpoint: true,
    signedIn: true,
    userId: "user-1",
    tokenExpiresAtMs: Date.now() + 3_600_000,
    expectedSchemaVersion: 1,
    backendSchemaVersion: 1,
    schemaStatus: "matched",
    capabilities: {
      broadcastSignals: true,
      storageSegments: false,
      homeEndpoints: false,
      teamInboxMentions: true,
      memberRuntime: true,
      sessionTurnIndex: false,
      offlineSync: false,
      orgChannels: false,
      orgChannelMessages: false,
      orgChannelMessagesIdempotency: false,
      conversationEvents: false,
    },
    capabilitiesLoading: false,
    lastSync: { lastPassAtMs: null, lastSuccessAtMs: null },
    coverage: {
      repos: [
        {
          repoScope: "github.com/acme/alpha",
          syncable: 6,
          synced: 2,
          percent: 33,
        },
        {
          repoScope: "github.com/acme/beta",
          syncable: 2,
          synced: 2,
          percent: 100,
        },
      ],
      syncable: 8,
      synced: 4,
      percent: 50,
    },
    entries: [],
    running: false,
    runSucceeded: false,
    runError: null,
    runSync: vi.fn(),
    clearLog: vi.fn(),
    ...overrides,
  };
}

function renderSection(
  overrides: Partial<CloudOrgSyncStatus> = {}
): DocumentFragment {
  const markup = renderToStaticMarkup(
    createElement(CloudOrgSyncSection, { t, status: status(overrides) })
  );
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content;
}

function entry(overrides: Partial<SyncJournalEntry> = {}): SyncJournalEntry {
  return {
    id: "sync-1",
    atMs: 1_700_000_000_000,
    level: "error",
    kind: "sync_pass",
    message: "cloud sync pass failed",
    ...overrides,
  };
}

describe("CloudOrgSyncSection connection block", () => {
  it("reports the backend kind, account, schema, and capability rows when signed in", () => {
    const root = renderSection();

    const endpointRow = root.querySelector(
      '[data-testid="cloud-org-sync-endpoint"]'
    );
    // Backend KIND only — never a URL.
    expect(endpointRow?.textContent).toContain(
      "cloud.orgPanel.sync.endpointOfficial"
    );
    expect(root.textContent ?? "").not.toContain("http");
    expect(
      root.querySelector('[data-testid="cloud-org-sync-account"]')?.textContent
    ).toContain("user-1");
    expect(
      root.querySelector('[data-testid="cloud-org-sync-token"]')
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="cloud-org-sync-signed-out"]')
    ).toBeNull();
    expect(
      root.querySelector('[data-testid="cloud-org-sync-schema-matched"]')
        ?.textContent
    ).toContain("cloud.orgPanel.sync.schemaMatched");
    expect(
      root.querySelectorAll("[data-testid^='cloud-org-sync-capability-']")
    ).toHaveLength(5);
    expect(
      root.querySelector(
        '[data-testid="cloud-org-sync-capability-broadcastSignals"]'
      )?.textContent
    ).toContain("cloud.orgPanel.sync.capabilityEnabled");
    expect(
      root.querySelector(
        '[data-testid="cloud-org-sync-capability-storageSegments"]'
      )?.textContent
    ).toContain("cloud.orgPanel.sync.capabilityDisabled");
  });

  it("degrades gracefully when signed out", () => {
    const root = renderSection({
      signedIn: false,
      userId: null,
      tokenExpiresAtMs: null,
      capabilities: null,
      capabilitiesLoading: false,
    });

    expect(
      root.querySelector('[data-testid="cloud-org-sync-signed-out"]')
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="cloud-org-sync-account"]')
    ).toBeNull();
    expect(
      root.querySelector('[data-testid="cloud-org-sync-token"]')
    ).toBeNull();
    expect(
      root.querySelector('[data-testid="cloud-org-sync-capabilities"]')
        ?.textContent
    ).toContain("cloud.orgPanel.sync.capabilitiesUnavailable");
    // Backend kind is still useful while signed out — still no URL.
    expect(
      root.querySelector('[data-testid="cloud-org-sync-endpoint"]')?.textContent
    ).toContain("cloud.orgPanel.sync.endpointOfficial");
    expect(root.textContent ?? "").not.toContain("http");
  });

  it("calls out a schema mismatch with both versions", () => {
    const root = renderSection({
      schemaStatus: "mismatched",
      backendSchemaVersion: 3,
    });

    const cell = root.querySelector(
      '[data-testid="cloud-org-sync-schema-mismatched"]'
    );
    expect(cell?.textContent).toBe("cloud.orgPanel.sync.schemaMismatch:3,1");
    expect(cell?.classList).toContain("text-danger-6");
  });

  it("shows a checking state before the probe resolves", () => {
    const root = renderSection({
      schemaStatus: "checking",
      backendSchemaVersion: null,
      capabilities: null,
      capabilitiesLoading: true,
    });

    expect(
      root.querySelector('[data-testid="cloud-org-sync-schema-checking"]')
        ?.textContent
    ).toBe("cloud.orgPanel.sync.schemaChecking");
    expect(
      root.querySelector('[data-testid="cloud-org-sync-capabilities"]')
        ?.textContent
    ).toContain("cloud.orgPanel.sync.capabilitiesChecking");
  });

  it("never renders an anon key or token value", () => {
    const markup = renderToStaticMarkup(
      createElement(CloudOrgSyncSection, { t, status: status() })
    );
    expect(markup).not.toContain("anonKey");
    expect(markup).not.toContain("accessToken");
    expect(markup.toLowerCase()).not.toContain("eyj");
  });
});

describe("CloudOrgSyncSection coverage block", () => {
  it("shows a loading row instead of a false empty state during the full scan", () => {
    const root = renderSection({
      coverageLoading: true,
    });

    expect(
      root.querySelector('[data-testid="cloud-org-sync-coverage-loading"]')
        ?.textContent
    ).toContain("cloud.orgPanel.loading");
    expect(
      root.querySelector('[data-testid="cloud-org-sync-coverage-empty"]')
    ).toBeNull();
    expect(root.textContent).not.toContain(
      "cloud.orgPanel.sync.coverageSummary"
    );
  });

  it("reports an unavailable aggregate instead of a false empty state", () => {
    const root = renderSection({
      coverageUnavailable: true,
      coverage: { repos: [], syncable: 0, synced: 0, percent: null },
    });

    expect(
      root.querySelector('[data-testid="cloud-org-sync-coverage-unavailable"]')
        ?.textContent
    ).toContain("cloud.orgPanel.loadError");
    expect(
      root.querySelector('[data-testid="cloud-org-sync-coverage-empty"]')
    ).toBeNull();
  });

  it("renders exactly one row per org repo scope, in order", () => {
    const root = renderSection();

    const rows = root.querySelectorAll(
      '[data-testid="cloud-org-sync-coverage-repo"]'
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("github.com/acme/alpha");
    expect(rows[1]?.textContent).toContain("github.com/acme/beta");

    const counts = root.querySelectorAll(
      '[data-testid="cloud-org-sync-coverage-repo-count"]'
    );
    expect(counts[0]?.textContent).toBe("2/6");
    expect(counts[1]?.textContent).toBe("2/2");

    const percents = root.querySelectorAll(
      '[data-testid="cloud-org-sync-coverage-repo-percent"]'
    );
    expect(percents[0]?.textContent).toBe("33%");
    expect(percents[1]?.textContent).toBe("100%");

    const bars = root.querySelectorAll('[role="progressbar"]');
    expect(bars).toHaveLength(2);
    expect(bars[0]?.getAttribute("aria-valuenow")).toBe("33");
    expect(bars[1]?.getAttribute("aria-valuenow")).toBe("100");
  });

  it("shows an empty state when no scoped repo has sessions", () => {
    const root = renderSection({
      coverage: { repos: [], syncable: 0, synced: 0, percent: null },
    });

    expect(
      root.querySelector('[data-testid="cloud-org-sync-coverage-empty"]')
        ?.textContent
    ).toContain("cloud.orgPanel.sync.coverageEmpty");
    expect(
      root.querySelector('[data-testid="cloud-org-sync-coverage-repo"]')
    ).toBeNull();
    expect(root.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("keeps a sliver of bar visible for a non-zero but tiny percentage", () => {
    const root = renderSection({
      coverage: {
        repos: [
          {
            repoScope: "github.com/acme/alpha",
            syncable: 400,
            synced: 1,
            percent: 0,
          },
        ],
        syncable: 400,
        synced: 1,
        percent: 0,
      },
    });

    // Rounds to 0% but IS synced — a fully empty bar would read as "none".
    const fill = root
      .querySelector('[role="progressbar"]')
      ?.querySelector("div");
    expect(fill?.getAttribute("style")).toContain("width:2%");
  });

  it("leaves the bar truly empty when nothing in the repo is synced", () => {
    const root = renderSection({
      coverage: {
        repos: [
          {
            repoScope: "github.com/acme/alpha",
            syncable: 9,
            synced: 0,
            percent: 0,
          },
        ],
        syncable: 9,
        synced: 0,
        percent: 0,
      },
    });

    const fill = root
      .querySelector('[role="progressbar"]')
      ?.querySelector("div");
    expect(fill?.getAttribute("style")).toContain("width:0%");
  });
});

describe("CloudOrgSyncSection last-sync block", () => {
  it("shows the never-synced empty state", () => {
    const root = renderSection();

    expect(
      root.querySelector('[data-testid="cloud-org-sync-last-never"]')
        ?.textContent
    ).toBe("cloud.orgPanel.sync.lastSyncNever");
    expect(
      root.querySelector('[data-testid="cloud-org-sync-last-value"]')
    ).toBeNull();
    expect(
      root.querySelector('[data-testid="cloud-org-sync-last-attempt"]')
    ).toBeNull();
  });

  it("shows relative plus absolute time for a real timestamp", () => {
    const lastSuccessAtMs = Date.now() - 2 * 60 * 60 * 1000;
    const root = renderSection({
      lastSync: { lastPassAtMs: lastSuccessAtMs, lastSuccessAtMs },
    });

    const value = root.querySelector(
      '[data-testid="cloud-org-sync-last-value"]'
    );
    expect(value?.textContent).toContain("2 hours ago");
    expect(value?.textContent).toContain(
      new Date(lastSuccessAtMs).toLocaleString()
    );
    expect(
      root.querySelector('[data-testid="cloud-org-sync-last-never"]')
    ).toBeNull();
  });

  it("adds a last-attempt row when the newest pass failed", () => {
    const lastSuccessAtMs = Date.now() - 60 * 60 * 1000;
    const root = renderSection({
      lastSync: { lastPassAtMs: Date.now() - 1_000, lastSuccessAtMs },
    });

    expect(
      root.querySelector('[data-testid="cloud-org-sync-last-attempt"]')
    ).not.toBeNull();
  });
});

describe("CloudOrgSyncSection manual sync", () => {
  it("disables the button and surfaces the running label while syncing", () => {
    const root = renderSection({ running: true });

    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-org-sync-run"]'
    );
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("cloud.orgPanel.sync.manualRunning");
  });

  it("surfaces success and failure inline", () => {
    const ok = renderSection({ runSucceeded: true });
    expect(
      ok.querySelector('[data-testid="cloud-org-sync-run-success"]')
        ?.textContent
    ).toBe("cloud.orgPanel.sync.manualSuccess");

    const failed = renderSection({ runError: "network down" });
    expect(
      failed.querySelector('[data-testid="cloud-org-sync-run-error"]')
        ?.textContent
    ).toBe("cloud.orgPanel.sync.manualError:network down");
    expect(
      failed.querySelector('[data-testid="cloud-org-sync-run-success"]')
    ).toBeNull();
  });

  it("places the outcome note to the LEFT of the primary button", () => {
    // The control cell right-aligns, so DOM order is what puts the note on
    // the left and keeps the button pinned to the edge.
    for (const [testId, root] of [
      ["cloud-org-sync-run-success", renderSection({ runSucceeded: true })],
      ["cloud-org-sync-run-error", renderSection({ runError: "network down" })],
    ] as const) {
      const note = root.querySelector(`[data-testid="${testId}"]`);
      const button = root.querySelector('[data-testid="cloud-org-sync-run"]');
      if (!note || !button) throw new Error(`missing ${testId} or run button`);
      expect(note.parentElement).toBe(button.parentElement);
      const siblings = Array.from(note.parentElement?.children ?? []);
      expect(siblings.indexOf(note)).toBeLessThan(siblings.indexOf(button));
    }
  });

  it("invokes runSync on click without throwing", async () => {
    const runSync = vi.fn();
    const root = createSmokeRoot();
    try {
      await root.render(
        createElement(CloudOrgSyncSection, { t, status: status({ runSync }) })
      );
      const button = root.container.querySelector<HTMLButtonElement>(
        '[data-testid="cloud-org-sync-run"]'
      );
      await dispatch(() => button?.click());
      expect(runSync).toHaveBeenCalledTimes(1);
    } finally {
      await root.unmount();
    }
  });
});

describe("CloudOrgSyncSection bug logs", () => {
  it("renders the empty state and disables both log actions", () => {
    const root = renderSection();

    expect(
      root.querySelector('[data-testid="cloud-org-sync-logs-empty"]')
        ?.textContent
    ).toContain("cloud.orgPanel.sync.logsEmpty");
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="cloud-org-sync-logs-clear"]'
      )?.disabled
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="cloud-org-sync-logs-copy"]'
      )?.disabled
    ).toBe(true);
  });

  it("renders entries newest first with level, kind, org, and code", () => {
    const root = renderSection({
      entries: [
        entry({
          id: "sync-2",
          level: "warn",
          kind: "org_backoff",
          orgId: "org-1",
          code: "ORG2_QUOTA_EXCEEDED",
          message: "backed off",
        }),
        entry({
          id: "sync-1",
          level: "info",
          kind: "sync_pass",
          message: "ok",
        }),
      ],
    });

    const items = root.querySelectorAll(
      '[data-testid="cloud-org-sync-log-entry"]'
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("backed off");
    expect(items[0]?.textContent).toContain("org_backoff");
    expect(items[0]?.textContent).toContain("ORG2_QUOTA_EXCEEDED");
    expect(items[0]?.textContent).toContain(
      "cloud.orgPanel.sync.logsOrg:org-1"
    );
    expect(items[1]?.textContent).toContain("ok");
    expect(
      root.querySelector('[data-testid="cloud-org-sync-log-level-warn"]')
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="cloud-org-sync-log-level-info"]')
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="cloud-org-sync-logs-empty"]')
    ).toBeNull();
  });

  it("renders an attributed member as a compact pill with the stable id in its tooltip", () => {
    const root = renderSection({
      entries: [
        entry({
          kind: "member_runtime",
          member: { userId: "user-vanta", displayName: "VantaNode" },
          message: "Runtime push failed; retrying in 300s",
        }),
      ],
    });

    const pill = root.querySelector(
      '[data-testid="cloud-org-sync-log-member"]'
    );
    expect(pill?.textContent).toBe("VVantaNode");
    expect(pill?.getAttribute("title")).toBe("VantaNode (user-vanta)");
    expect(
      root.querySelector('[data-testid="cloud-org-sync-log-entry"]')
        ?.textContent
    ).toContain("VantaNode:Runtime push failed; retrying in 300s");
    expect(
      root.querySelector('[data-testid="cloud-org-sync-logs-member-filter"]')
        ?.textContent
    ).toContain("cloud.sidebar.everyone");
  });

  it("filters the rendered and copied slice by the selected member", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const root = createSmokeRoot();
    try {
      await root.render(
        createElement(CloudOrgSyncSection, {
          t,
          status: status({
            entries: [
              entry({
                id: "sync-vanta",
                member: { userId: "user-vanta", displayName: "VantaNode" },
                message: "vanta failure",
              }),
              entry({
                id: "sync-ada",
                member: { userId: "user-ada", displayName: "Ada" },
                message: "ada failure",
              }),
              entry({ id: "sync-system", message: "system failure" }),
            ],
          }),
        })
      );

      const filter = root.container.querySelector<HTMLElement>(
        '[data-testid="cloud-org-sync-logs-member-filter"]'
      );
      await dispatch(() => filter?.click());
      const adaOption = document.body.querySelector<HTMLElement>(
        '[data-testid="cloud-org-sync-logs-member-user-ada"]'
      );
      expect(adaOption).not.toBeNull();
      await dispatch(() => adaOption?.click());

      const items = root.container.querySelectorAll(
        '[data-testid="cloud-org-sync-log-entry"]'
      );
      expect(items).toHaveLength(1);
      expect(items[0]?.textContent).toContain("Ada:ada failure");
      expect(root.container.textContent).not.toContain("vanta failure");
      expect(root.container.textContent).not.toContain("system failure");

      const copyButton = root.container.querySelector<HTMLButtonElement>(
        '[data-testid="cloud-org-sync-logs-copy"]'
      );
      await dispatch(() => copyButton?.click());
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const copiedText = String(writeText.mock.calls[0]?.[0]);
      expect(copiedText).toContain("member Ada (user-ada)");
      expect(copiedText).toContain("ada failure");
      expect(copiedText).not.toContain("vanta failure");
      expect(copiedText).not.toContain("system failure");
    } finally {
      await root.unmount();
    }
  });

  it("renders at most the newest 50 entries", () => {
    const root = renderSection({
      entries: Array.from({ length: 100 }, (_, index) =>
        entry({ id: `sync-${100 - index}`, message: `entry-${100 - index}` })
      ),
    });

    const items = root.querySelectorAll(
      '[data-testid="cloud-org-sync-log-entry"]'
    );
    expect(items).toHaveLength(50);
    expect(items[0]?.textContent).toContain("entry-100");
    expect(items[49]?.textContent).toContain("entry-51");
  });

  it("calls clearLog from the clear button", async () => {
    const clearLog = vi.fn();
    const root = createSmokeRoot();
    try {
      await root.render(
        createElement(CloudOrgSyncSection, {
          t,
          status: status({ clearLog, entries: [entry()] }),
        })
      );
      const button = root.container.querySelector<HTMLButtonElement>(
        '[data-testid="cloud-org-sync-logs-clear"]'
      );
      expect(button?.disabled).toBe(false);
      await dispatch(() => button?.click());
      expect(clearLog).toHaveBeenCalledTimes(1);
    } finally {
      await root.unmount();
    }
  });
});

describe("formatSyncJournalForCopy", () => {
  it("emits one plain-text line per entry with the optional fields", () => {
    const text = formatSyncJournalForCopy([
      entry({
        id: "sync-2",
        level: "warn",
        kind: "org_backoff",
        orgId: "org-1",
        member: { userId: "user-vanta", displayName: "VantaNode" },
        code: "ORG2_SYNC_DISABLED",
        message: "backed off",
      }),
      entry({ id: "sync-1", level: "info", message: "ok" }),
    ]);

    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(
      "WARN | org_backoff | org-1 | member VantaNode (user-vanta) | ORG2_SYNC_DISABLED"
    );
    expect(lines[0]?.endsWith("backed off")).toBe(true);
    expect(lines[1]).toContain("INFO | sync_pass");
    expect(lines[1]).not.toContain("|  |");
  });

  it("returns an empty string for an empty journal", () => {
    expect(formatSyncJournalForCopy([])).toBe("");
  });
});
