import { invoke } from "@tauri-apps/api/core";

import { asError } from "../result";
import type { Json, Result } from "../types";

export function createRuntimeDebugHelpers() {
  const debugSessionSecuritySnapshot = async (
    sessionId: string
  ): Promise<Result<{ snapshot: Json }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "debugSessionSecuritySnapshot: `sessionId` is required",
        };
      }
      const snapshot = (await invoke("debug_session_security_snapshot", {
        sessionId,
      })) as Json;
      return { ok: true, snapshot };
    } catch (err) {
      return asError(err);
    }
  };

  const debugSessionValidateCommand = async (
    sessionId: string,
    command: string,
    approved?: boolean | null
  ): Promise<Result<{ validation: Json }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "debugSessionValidateCommand: `sessionId` is required",
        };
      }
      if (typeof command !== "string" || command.length === 0) {
        return {
          ok: false,
          error: "debugSessionValidateCommand: `command` is required",
        };
      }
      const validation = (await invoke("debug_session_validate_command", {
        sessionId,
        command,
        approved: approved ?? null,
      })) as Json;
      return { ok: true, validation };
    } catch (err) {
      return asError(err);
    }
  };

  const debugSessionSubagentSnapshot = async (
    sessionId: string
  ): Promise<Result<{ snapshot: Json }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "debugSessionSubagentSnapshot: `sessionId` is required",
        };
      }
      const snapshot = (await invoke("debug_session_subagent_snapshot", {
        sessionId,
      })) as Json;
      return { ok: true, snapshot };
    } catch (err) {
      return asError(err);
    }
  };

  const debugSessionModelSnapshot = async (
    sessionId: string
  ): Promise<Result<{ snapshot: Json }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "debugSessionModelSnapshot: `sessionId` is required",
        };
      }
      const snapshot = (await invoke("debug_session_model_snapshot", {
        sessionId,
      })) as Json;
      return { ok: true, snapshot };
    } catch (err) {
      return asError(err);
    }
  };

  const debugSessionToolsSnapshot = async (
    sessionId: string
  ): Promise<Result<{ snapshot: Json }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "debugSessionToolsSnapshot: `sessionId` is required",
        };
      }
      const snapshot = (await invoke("debug_session_tools_snapshot", {
        sessionId,
      })) as Json;
      return { ok: true, snapshot };
    } catch (err) {
      return asError(err);
    }
  };

  const listEffectiveToolsForSession = async (
    sessionId: string,
    agentExecMode?: string | null
  ): Promise<Result<{ tools: Json }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "listEffectiveToolsForSession: `sessionId` is required",
        };
      }
      const tools = (await invoke("agent_list_effective_tools_for_session", {
        request: {
          sessionId,
          agentExecMode: agentExecMode ?? null,
        },
      })) as Json;
      return { ok: true, tools };
    } catch (err) {
      return asError(err);
    }
  };

  const debugSessionSkillsSnapshot = async (
    sessionId: string
  ): Promise<Result<{ snapshot: Json }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "debugSessionSkillsSnapshot: `sessionId` is required",
        };
      }
      const snapshot = (await invoke("debug_session_skills_snapshot", {
        sessionId,
      })) as Json;
      return { ok: true, snapshot };
    } catch (err) {
      return asError(err);
    }
  };

  const debugSessionContextCacheSnapshot = async (
    sessionId: string
  ): Promise<Result<{ snapshot: Json }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "debugSessionContextCacheSnapshot: `sessionId` is required",
        };
      }
      const snapshot = (await invoke("debug_session_context_cache_snapshot", {
        sessionId,
      })) as Json;
      return { ok: true, snapshot };
    } catch (err) {
      return asError(err);
    }
  };

  const debugSessionGeneralSnapshot = async (
    sessionId: string
  ): Promise<Result<{ snapshot: Json }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "debugSessionGeneralSnapshot: `sessionId` is required",
        };
      }
      const snapshot = (await invoke("debug_session_general_snapshot", {
        sessionId,
      })) as Json;
      return { ok: true, snapshot };
    } catch (err) {
      return asError(err);
    }
  };

  return {
    debugSessionSecuritySnapshot,
    debugSessionValidateCommand,
    debugSessionSubagentSnapshot,
    debugSessionModelSnapshot,
    debugSessionContextCacheSnapshot,
    debugSessionToolsSnapshot,
    listEffectiveToolsForSession,
    debugSessionSkillsSnapshot,
    debugSessionGeneralSnapshot,
  };
}
