import type { KanbanTask } from "@src/features/KanbanBoard";

import { resolveKanbanPreviewTask } from "./cloudSessionPreview";

function task(overrides: Partial<KanbanTask> & { id: string }): KanbanTask {
  return {
    title: overrides.id,
    status: "turn_finished",
    ...overrides,
  } as KanbanTask;
}

describe("resolveKanbanPreviewTask", () => {
  const cloudTask = task({ id: "cloud-remote:row-1", title: "Supabase" });
  const target = {
    taskId: cloudTask.id,
    sessionId: "imported-session-1",
  };

  it("returns the selected task untouched without an import in flight", () => {
    expect(resolveKanbanPreviewTask(cloudTask, null, [cloudTask])).toBe(
      cloudTask
    );
  });

  it("grafts the pending session id onto the cloud card while importing", () => {
    const preview = resolveKanbanPreviewTask(cloudTask, target, [cloudTask]);

    expect(preview).toMatchObject({
      id: cloudTask.id,
      title: "Supabase",
      session_id: "imported-session-1",
    });
  });

  it("hands over to the imported copy once it lands on the board", () => {
    const importedTask = task({
      id: "imported-session-1",
      session_id: "imported-session-1",
      title: "Supabase",
    });

    expect(resolveKanbanPreviewTask(cloudTask, target, [importedTask])).toBe(
      importedTask
    );
  });

  it("still previews the imported copy after the cloud card is dropped", () => {
    const importedTask = task({
      id: "imported-session-1",
      session_id: "imported-session-1",
    });

    expect(resolveKanbanPreviewTask(null, target, [importedTask])).toBe(
      importedTask
    );
  });

  it("leaves another selected card alone when the target is stale", () => {
    const localTask = task({ id: "local-1", session_id: "local-1" });

    expect(resolveKanbanPreviewTask(localTask, target, [localTask])).toBe(
      localTask
    );
  });
});
