import { invoke } from "@tauri-apps/api/core";

import { rpc } from "@src/api/tauri/rpc";

import { asError } from "../result";
import type { Err, Json, Result } from "../types";

export function createMemoryHelpers() {
  const listWorkspaceMemory = async (
    workspace: string
  ): Promise<Result<{ files: Json[] }>> => {
    try {
      const files = (await rpc.workspaceMemory.list({ workspace })) as Json[];
      return { ok: true, files };
    } catch (err) {
      return asError(err);
    }
  };

  const readWorkspaceMemory = async (
    workspace: string,
    filename: string
  ): Promise<Result<{ detail: Json }>> => {
    try {
      const detail = (await rpc.workspaceMemory.read({
        workspace,
        filename,
      })) as Json;
      return { ok: true, detail };
    } catch (err) {
      return asError(err);
    }
  };

  const writeWorkspaceMemory = async (
    workspace: string,
    filename: string,
    content: string
  ): Promise<{ ok: true } | Err> => {
    try {
      await rpc.workspaceMemory.write({ workspace, filename, content });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const deleteWorkspaceMemory = async (
    workspace: string,
    filename: string
  ): Promise<{ ok: true } | Err> => {
    try {
      await rpc.workspaceMemory.delete({ workspace, filename });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const clearWorkspaceMemory = async (
    workspace: string
  ): Promise<Result<{ removed: number }>> => {
    try {
      const removed = (await rpc.workspaceMemory.clear({
        workspace,
      })) as number;
      return { ok: true, removed };
    } catch (err) {
      return asError(err);
    }
  };

  const workspaceMemoryStatus = async (
    workspace: string
  ): Promise<Result<{ status: Json }>> => {
    try {
      const status = (await rpc.workspaceMemory.status({ workspace })) as Json;
      return { ok: true, status };
    } catch (err) {
      return asError(err);
    }
  };

  const workspaceMemoryIndex = async (
    workspace: string
  ): Promise<Result<{ content: string }>> => {
    try {
      const content = (await rpc.workspaceMemory.index({
        workspace,
      })) as string;
      return { ok: true, content };
    } catch (err) {
      return asError(err);
    }
  };

  const debugMemoryPrefetchSection = async (
    workspace: string,
    userQuery?: string | null
  ): Promise<Result<{ section: string | null }>> => {
    try {
      const section = (await invoke("debug_memory_prefetch_section", {
        workspace,
        userQuery: userQuery ?? null,
      })) as string | null;
      return { ok: true, section };
    } catch (err) {
      return asError(err);
    }
  };

  const learningsList = async (input?: {
    agentScope?: string | null;
    status?: string | null;
    source?: string | null;
    category?: string | null;
    search?: string | null;
    limit?: number | null;
  }): Promise<Result<{ learnings: Json[] }>> => {
    try {
      const payload: Record<string, unknown> = {};
      if (input?.agentScope) payload.agentScope = input.agentScope;
      if (input?.status) payload.status = input.status;
      if (input?.source) payload.source = input.source;
      if (input?.category) payload.category = input.category;
      if (input?.search) payload.search = input.search;
      if (input?.limit != null) payload.limit = input.limit;
      const learnings = (await rpc.learning.browseList(
        payload as Parameters<typeof rpc.learning.browseList>[0]
      )) as Json[];
      return { ok: true, learnings };
    } catch (err) {
      return asError(err);
    }
  };

  const learningsUpdateBody = async (
    learningId: string,
    content: string,
    takeaway?: string | null
  ): Promise<{ ok: true } | Err> => {
    try {
      await rpc.learning.updateBody({
        learningId,
        content,
        takeaway: takeaway ?? undefined,
      });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const learningsSetStatus = async (
    learningId: string,
    next: "pending" | "active" | "merged" | "deprecated"
  ): Promise<{ ok: true } | Err> => {
    try {
      await rpc.learning.setStatus({ learningId, next });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const learningsDelete = async (
    learningId: string
  ): Promise<{ ok: true } | Err> => {
    try {
      await rpc.learning.remove({ learningId });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const learningsGetStatus = async (
    agentScope?: string | null
  ): Promise<Result<{ report: Json }>> => {
    try {
      const report = (await rpc.learning.getStatus({
        agentScope: agentScope ?? undefined,
      })) as Json;
      return { ok: true, report };
    } catch (err) {
      return asError(err);
    }
  };

  const learningsTriggerReflection = async (
    sessionId: string
  ): Promise<Result<{ result: Json }>> => {
    try {
      const result = (await rpc.learning.triggerReflection({
        sessionId,
      })) as Json;
      return { ok: true, result };
    } catch (err) {
      return asError(err);
    }
  };

  const learningsDeprecate = async (
    learningId: string
  ): Promise<{ ok: true } | Err> => {
    try {
      await rpc.learning.deprecate({ learningId });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const debugSeedLearning = async (input: {
    agentScope: string;
    content: string;
    takeaway?: string | null;
    status?: string | null;
    source?: string | null;
    category?: string | null;
  }): Promise<Result<{ learningId: string }>> => {
    try {
      const learningId = (await invoke("debug_seed_learning", {
        agentScope: input.agentScope,
        content: input.content,
        takeaway: input.takeaway ?? null,
        status: input.status ?? null,
        source: input.source ?? null,
        category: input.category ?? null,
      })) as string;
      return { ok: true, learningId };
    } catch (err) {
      return asError(err);
    }
  };

  return {
    listWorkspaceMemory,
    readWorkspaceMemory,
    writeWorkspaceMemory,
    deleteWorkspaceMemory,
    clearWorkspaceMemory,
    workspaceMemoryStatus,
    workspaceMemoryIndex,
    debugMemoryPrefetchSection,
    learningsList,
    learningsUpdateBody,
    learningsSetStatus,
    learningsDelete,
    learningsGetStatus,
    learningsTriggerReflection,
    learningsDeprecate,
    debugSeedLearning,
  };
}
