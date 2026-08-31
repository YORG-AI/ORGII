// @vitest-environment jsdom
import { type ComponentProps, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "@src/store/session";

import { SessionImportExportModal } from "../SessionImportExportModal";
import type { SessionExportDraft } from "../sessionImportExport";

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  buildDraft: vi.fn(),
  openDialog: vi.fn(),
  saveDialog: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}));
vi.mock("@src/store/ui/overlayLayerAtom", () => ({
  useOverlayLayer: vi.fn(),
}));
vi.mock("@src/components/Message", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openDialog,
  save: mocks.saveDialog,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: mocks.writeTextFile,
}));
vi.mock("../sessionImportExport", () => ({
  SESSION_JSON_FILTER: { name: "Session JSON", extensions: ["json"] },
  buildSessionExportDraft: mocks.buildDraft,
  formatCategoryLabel: () => "Rust Agent",
  formatEventCount: (count: number) => `${count} events`,
  stringifySessionExportFile: JSON.stringify,
  importSessionExportFile: vi.fn(),
  parseSessionImportFile: vi.fn(),
}));

const session: Session = {
  session_id: "session-export",
  status: "completed",
  created_at: "2026-08-30T15:00:00Z",
  updated_at: "2026-08-30T15:00:00Z",
  name: "Table lines without separators and sort support",
  category: "rust_agent",
};
const draft: SessionExportDraft = {
  preview: {
    sessionId: session.session_id,
    displayName: session.name!,
    category: "rust_agent",
    eventCount: 0,
    fileName: `${session.name}.orgii-session.json`,
    exportedAt: session.updated_at,
  },
  file: {
    format: "orgii.session.export",
    version: 1,
    exportedAt: session.updated_at,
    session: {
      session_id: session.session_id,
      status: session.status,
      created_at: session.created_at,
      updated_at: session.updated_at,
      category: "rust_agent",
    },
    metadata: { originalCategory: "rust_agent", eventCount: 0 },
    payload: { events: [] },
  },
};

let container: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof SessionImportExportModal>;

async function render(
  overrides: Partial<ComponentProps<typeof SessionImportExportModal>> = {}
) {
  props = { ...props, ...overrides };
  await act(async () => {
    root.render(createElement(SessionImportExportModal, props));
  });
}

function button(label: string): HTMLButtonElement {
  const result = [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent === label
  );
  expect(result, label).toBeDefined();
  return result!;
}

function modalContent(): HTMLElement {
  const result = document.querySelector<HTMLElement>(".liquid-modal-content");
  expect(result).not.toBeNull();
  return result!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.buildDraft.mockResolvedValue(draft);
  mocks.saveDialog.mockResolvedValue("/exports/session.json");
  mocks.openDialog.mockResolvedValue(null);
  mocks.writeTextFile.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    visible: true,
    mode: "export",
    activeSession: session,
    sessionFallbackName: "Session",
    onClose: vi.fn(),
    onImported: vi.fn(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SessionImportExportModal", () => {
  it("widens export and shows its details without the introductory card", async () => {
    await render();

    const modal = modalContent();
    expect(modal.style.width).toBe("640px");
    expect(modal.textContent).not.toContain("exportDescription");
    expect(modal.textContent).not.toContain("jsonSnapshotNote");
    expect(modal.querySelector('[data-icon="folder-output"]')).toBeNull();
    expect(modal.querySelector(".border-border-1.bg-bg-1")).toBeNull();
    expect(modal.textContent).toContain(draft.preview.displayName);
    expect(modal.textContent).toContain("Rust Agent");
    expect(modal.textContent).toContain("0 events");
    expect(modal.textContent).toContain(draft.preview.fileName);
    const labels = [...modal.querySelectorAll("span")].filter((element) =>
      element.textContent?.startsWith("chat.importExport.fields.")
    );
    expect(labels).toHaveLength(4);
    for (const label of labels) {
      expect(label.classList.contains("shrink-0")).toBe(true);
      expect(label.classList.contains("whitespace-nowrap")).toBe(true);
    }
    expect(button("chat.importExport.exportAction").disabled).toBe(false);
    expect(button("common:actions.cancel").disabled).toBe(false);
  });

  it("still exports the prepared snapshot from the footer", async () => {
    await render();
    await act(async () => button("chat.importExport.exportAction").click());

    expect(mocks.saveDialog).toHaveBeenCalledWith({
      defaultPath: draft.preview.fileName,
      filters: [{ name: "Session JSON", extensions: ["json"] }],
    });
    expect(mocks.writeTextFile).toHaveBeenCalledWith(
      "/exports/session.json",
      JSON.stringify(draft.file)
    );
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onImported).not.toHaveBeenCalled();
  });

  it("still cancels without exporting", async () => {
    await render();
    await act(async () => button("common:actions.cancel").click());

    expect(props.onClose).toHaveBeenCalledOnce();
    expect(mocks.saveDialog).not.toHaveBeenCalled();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("keeps a loading message and disables export until the preview is ready", async () => {
    let resolveDraft!: (value: SessionExportDraft) => void;
    mocks.buildDraft.mockReturnValueOnce(
      new Promise<SessionExportDraft>((resolve) => {
        resolveDraft = resolve;
      })
    );
    await render();

    expect(modalContent().textContent).toContain("loadingPreview");
    expect(button("chat.importExport.exportAction").disabled).toBe(true);
    await act(async () => resolveDraft(draft));
    expect(modalContent().textContent).not.toContain("loadingPreview");
    expect(button("chat.importExport.exportAction").disabled).toBe(false);
  });

  it("keeps export unavailable when no session is active", async () => {
    await render({ activeSession: undefined });

    expect(modalContent().textContent).toContain("noActiveSession");
    expect(button("chat.importExport.exportAction").disabled).toBe(true);
    expect(mocks.buildDraft).not.toHaveBeenCalled();
  });

  it("preserves the import width, guidance, and file picker", async () => {
    await render({ mode: "import" });

    expect(modalContent().style.width).toBe("440px");
    expect(modalContent().textContent).toContain("importDescription");
    expect(modalContent().textContent).toContain("jsonSnapshotNote");
    expect(modalContent().textContent).toContain("chooseJsonHint");
    expect(mocks.buildDraft).not.toHaveBeenCalled();
    await act(async () => button("chat.importExport.chooseJson").click());
    expect(mocks.openDialog).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: "Session JSON", extensions: ["json"] }],
    });
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
