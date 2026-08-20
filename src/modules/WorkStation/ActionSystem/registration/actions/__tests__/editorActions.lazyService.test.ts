import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  editorGoToLine,
  editorUndo,
} from "@src/modules/WorkStation/ActionSystem/registration/actions/editorActions.zod";

const editorServiceMock = vi.hoisted(() => ({
  loads: 0,
  service: {
    hasEditorView: vi.fn(() => false),
    goToLine: vi.fn(() => false),
    find: vi.fn(() => false),
    replace: vi.fn(() => false),
    undo: vi.fn(() => false),
    redo: vi.fn(() => false),
    format: vi.fn(() => false),
    fold: vi.fn(() => false),
    unfold: vi.fn(() => false),
  },
}));

// The real EditorService statically imports @codemirror/{view,state,search,
// commands}; the actions must reach it through a dynamic import so those
// packages stay out of the startup graph (GlobalShortcuts → ActionSystem
// registers these actions at boot).
vi.mock("@src/services/workStation/EditorService", () => {
  editorServiceMock.loads += 1;
  return { EditorService: editorServiceMock.service };
});

describe("editor actions load EditorService lazily", () => {
  beforeEach(() => {
    editorServiceMock.service.goToLine.mockClear();
    editorServiceMock.service.undo.mockClear();
    editorServiceMock.service.hasEditorView.mockClear();
  });

  it("does not evaluate EditorService when the action module is imported", () => {
    // Importing the actions module (as boot does) must not touch the service.
    expect(editorServiceMock.loads).toBe(0);
  });

  it("loads the service on first execution and reports missing editor", async () => {
    const result = await editorGoToLine.execute({ line: 42 });
    expect(editorServiceMock.loads).toBe(1);
    expect(editorServiceMock.service.goToLine).toHaveBeenCalledWith(42);
    expect(result.success).toBe(false);
    expect(result.message).toBe("No editor is currently open");
  });

  it("succeeds when the service reports success", async () => {
    editorServiceMock.service.undo.mockReturnValueOnce(true);
    const result = await editorUndo.execute({});
    expect(result.success).toBe(true);
    // Still a single module evaluation across actions.
    expect(editorServiceMock.loads).toBe(1);
  });
});
