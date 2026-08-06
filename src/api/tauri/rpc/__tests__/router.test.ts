import { beforeEach, describe, expect, it, vi } from "vitest";

import { RpcError } from "../invoke";
import { rpc } from "../router";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("typed RPC router", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("calls nested procedures through recursive domains", async () => {
    invokeMock.mockResolvedValue({
      totalSessions: 1,
      totalEvents: 2,
      dbSizeBytes: 3,
    });

    const stats = await rpc.sessionCore.cache.getStats();

    expect(stats).toEqual({
      totalSessions: 1,
      totalEvents: 2,
      dbSizeBytes: 3,
    });
    expect(invokeMock).toHaveBeenCalledWith("cache_get_stats", {});
  });

  it("validates nested procedure input before invoking Tauri", async () => {
    await expect(
      rpc.sessionCore.cache.loadEvents({
        sessionId: 123 as unknown as string,
      })
    ).rejects.toBeInstanceOf(RpcError);

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("routes session deletion through the relationship-cleanup command", async () => {
    invokeMock.mockResolvedValue(undefined);

    await rpc.agentSession.deleteSession({ sessionId: "session-delete-1" });

    expect(invokeMock).toHaveBeenCalledWith("agent_delete_session", {
      sessionId: "session-delete-1",
    });
  });

  it("routes Work Item unlink through the fail-closed lifecycle command", async () => {
    invokeMock.mockResolvedValue(true);

    await expect(
      rpc.agentSession.unlinkSessionFromWorkItem({
        sessionId: "session-unlink-1",
      })
    ).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledWith(
      "agent_unlink_session_from_work_item",
      {
        sessionId: "session-unlink-1",
      }
    );
  });

  it("preserves omitted, null, and value runtime settings in the narrow key mutation", async () => {
    invokeMock.mockResolvedValue({ id: "key-1" });

    await rpc.validation.updateModelRuntimeSettings({
      request: { key_id: "key-1", model: "gpt-5.5" },
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      "update_model_runtime_settings",
      {
        request: { key_id: "key-1", model: "gpt-5.5" },
      }
    );

    await rpc.validation.updateModelRuntimeSettings({
      request: {
        key_id: "key-1",
        model: "gpt-5.5",
        reasoning_effort_override: null,
      },
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      "update_model_runtime_settings",
      {
        request: {
          key_id: "key-1",
          model: "gpt-5.5",
          reasoning_effort_override: null,
        },
      }
    );

    await rpc.validation.updateModelRuntimeSettings({
      request: {
        key_id: "key-1",
        model: "gpt-5.5",
        context_window_override: 128000,
      },
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      "update_model_runtime_settings",
      {
        request: {
          key_id: "key-1",
          model: "gpt-5.5",
          context_window_override: 128000,
        },
      }
    );
  });

  it("transforms Rust global path exemption access to the frontend DTO", async () => {
    invokeMock.mockResolvedValue([
      {
        id: "grant-1",
        canonicalPath: "/tmp/exempt",
        access: "read_write",
        recursive: true,
        createdAt: "2026-08-05T00:00:00Z",
        updatedAt: "2026-08-05T00:00:00Z",
      },
    ]);

    await expect(rpc.globalPathExemptions.list()).resolves.toEqual([
      {
        id: "grant-1",
        canonicalPath: "/tmp/exempt",
        access: "readWrite",
        recursive: true,
        createdAt: "2026-08-05T00:00:00Z",
        updatedAt: "2026-08-05T00:00:00Z",
      },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("global_path_exemptions_list", {});
  });

  it("binds global path exemption mutation parameters to their Rust names", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "grant-agents",
      canonical_path: "/home/panshuainan/.agents",
      access: "read_write",
      recursive: true,
      created_at: "2026-08-05T00:00:00Z",
      updated_at: "2026-08-05T00:00:00Z",
    });

    await expect(
      rpc.globalPathExemptions.add({ path: "/home/panshuainan/.agents" })
    ).resolves.toEqual({
      id: "grant-agents",
      canonicalPath: "/home/panshuainan/.agents",
      access: "readWrite",
      recursive: true,
      createdAt: "2026-08-05T00:00:00Z",
      updatedAt: "2026-08-05T00:00:00Z",
    });
    expect(invokeMock).toHaveBeenLastCalledWith("global_path_exemptions_add", {
      path: "/home/panshuainan/.agents",
    });

    invokeMock.mockResolvedValueOnce(true);
    await expect(
      rpc.globalPathExemptions.remove({ id: "grant-agents" })
    ).resolves.toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "global_path_exemptions_remove",
      {
        id: "grant-agents",
      }
    );
  });

  it("accepts effective tools output with omitted serde-default fields", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error");
    invokeMock.mockResolvedValue({
      sessionId: "sde-test",
      agentExecMode: "plan",
      registeredToolNames: ["read_file", "create_plan"],
      promptToolNames: ["read_file"],
      deferredToolNames: ["manage_nodes"],
      promptTools: [
        {
          name: "read_file",
          description: "Read files",
          category: "filesystem",
        },
        {
          name: "create_plan",
          description: "Create plan",
          category: "planning",
          source: "builtin",
          supported_agents: ["sde"],
          icon_id: "list-checks",
          actionIcons: { create: "plus" },
          statusIcons: { approved: "check" },
          simulatorApp: "CHANNELS",
          appSubtool: "message",
          chatBlock: "plan_doc",
          humanToolKey: null,
          hidden: false,
          labelRunning: "sessions:tools.createPlan.running",
          labelDone: "sessions:tools.createPlan.done",
          labelFailed: "sessions:tools.createPlan.failed",
          statusLabels: { approved: "sessions:tools.createPlan.approved" },
          actions: [
            {
              name: "create",
              summary: "Create a plan",
              appSubtool: "message",
              chatBlock: "plan_doc",
              labelRunning: "sessions:tools.createPlan.running",
              labelDone: "sessions:tools.createPlan.done",
              labelFailed: "sessions:tools.createPlan.failed",
              statusLabels: { approved: "sessions:tools.createPlan.approved" },
            },
          ],
          requiredCapability: "coding",
        },
      ],
    });

    const result = await rpc.tools.listEffectiveToolsForSession({
      request: { sessionId: "sde-test", agentExecMode: "plan" },
    });

    expect(result.promptToolNames).toEqual(["read_file"]);
    expect(invokeMock).toHaveBeenCalledWith(
      "agent_list_effective_tools_for_session",
      {
        request: { sessionId: "sde-test", agentExecMode: "plan" },
      }
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("reports nested procedure output validation failures in development", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error");
    invokeMock.mockResolvedValue({ totalSessions: "bad" });

    await rpc.sessionCore.cache.getStats();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[RPC:cache_get_stats] Output validation failed",
      expect.any(Array),
      "Raw:",
      { totalSessions: "bad" }
    );
  });
});
