import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineAppActionRegistration } from "@src/ActionSystem/schema/actionRegistration";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import { rpc } from "@src/api/tauri/rpc";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";

const sessionCreateParams = z
  .object({
    task: z.string().min(1).optional(),
    repoPath: z.string().optional(),
    name: z.string().min(1).optional(),
    model: z.string().optional(),
    accountId: z.string().optional(),
    agentDefinitionId: z.string().optional(),
  })
  .refine((params) => Boolean(params.task || params.name), {
    message: "Either task or name is required",
    path: ["task"],
  });

const sessionListParams = z.object({
  status: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

const sessionIdParams = z.object({
  sessionId: z.string().min(1),
});

export const sessionCreate = defineZodAction(
  {
    id: ACTION_ID.SESSION_CREATE,
    category: "session",
    description: "Immediately create and start an ORGII agent session",
    params: sessionCreateParams,
    layer: "action",
    tags: ["session", "agent", "create"],
    examples: ["create a session", "start an agent session"],
  },
  async (params) => {
    const task = params.task ?? params.name;
    if (!task) {
      return {
        success: false,
        message: "Either task or name is required",
      };
    }

    const result = await SessionService.create({
      task,
      repoPath: params.repoPath,
      name: params.name ?? task,
      model: params.model,
      accountId: params.accountId,
      agentDefinitionId: params.agentDefinitionId,
    });
    return {
      success: true,
      message: `Created session ${result.sessionId}`,
      data: result,
    };
  }
);

export const sessionList = defineZodAction(
  {
    id: ACTION_ID.SESSION_LIST,
    category: "session",
    description: "List ORGII agent sessions",
    params: sessionListParams,
    layer: "action",
    tags: ["session", "agent", "list"],
    examples: ["list sessions", "show running sessions"],
  },
  async (params) => {
    const sessions = await SessionService.list(params);
    return {
      success: true,
      message: `Found ${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
      data: { sessions },
    };
  }
);

export const sessionGetStatus = defineZodAction(
  {
    id: ACTION_ID.SESSION_GET_STATUS,
    category: "session",
    description: "Get detailed status for an ORGII agent session",
    params: sessionIdParams,
    layer: "action",
    tags: ["session", "agent", "status"],
    examples: ["get session status", "check session progress"],
  },
  async (params) => {
    const status = await SessionService.getStatus(params);
    return {
      success: true,
      message: `Session ${params.sessionId} status: ${status.status}`,
      data: status,
    };
  }
);

export const sessionSendMessage = defineZodAction(
  {
    id: ACTION_ID.SESSION_SEND_MESSAGE,
    category: "session",
    description: "Send a follow-up message to an ORGII agent session",
    params: sessionIdParams.extend({ content: z.string().min(1) }),
    layer: "action",
    tags: ["session", "agent", "message"],
    examples: ["send a message to a session", "continue a session"],
  },
  async (params) => {
    await SessionService.sendMessage(params);
    return { success: true, message: `Sent message to ${params.sessionId}` };
  }
);

export const sessionAnswerQuestion = defineZodAction(
  {
    id: ACTION_ID.SESSION_ANSWER_QUESTION,
    category: "session",
    description: "Answer a pending question for an ORGII agent session",
    params: sessionIdParams.extend({
      questionId: z.string().min(1),
      answer: z.string().min(1),
    }),
    layer: "action",
    tags: ["session", "agent", "question"],
    examples: ["answer a session question"],
  },
  async (params) => {
    await SessionService.answerQuestion(params);
    return {
      success: true,
      message: `Answered question ${params.questionId} for ${params.sessionId}`,
    };
  }
);

export const sessionCancel = defineZodAction(
  {
    id: ACTION_ID.SESSION_CANCEL,
    category: "session",
    description: "Cancel or stop an ORGII agent session",
    params: sessionIdParams.extend({ force: z.boolean().optional() }),
    layer: "action",
    tags: ["session", "agent", "cancel", "stop"],
    examples: ["cancel a session", "stop a session"],
  },
  async (params) => {
    await SessionService.cancel(params);
    return { success: true, message: `Cancelled ${params.sessionId}` };
  }
);

export const sessionResume = defineZodAction(
  {
    id: ACTION_ID.SESSION_RESUME,
    category: "session",
    description: "Resume a paused CLI-backed ORGII session",
    params: sessionIdParams,
    layer: "action",
    tags: ["session", "agent", "resume"],
    examples: ["resume a session"],
  },
  async (params) => {
    await SessionService.resume(params);
    return { success: true, message: `Resumed ${params.sessionId}` };
  }
);

export const sessionPause = defineZodAction(
  {
    id: ACTION_ID.SESSION_PAUSE,
    category: "session",
    description: "Pause an ORGII agent session if supported",
    params: sessionIdParams,
    layer: "action",
    tags: ["session", "agent", "pause"],
    examples: ["pause a session"],
  },
  async () => ({
    success: false,
    message: "Pausing sessions is not currently supported by the ORGII frontend service",
  })
);

export const sessionOpen = defineZodAction(
  {
    id: ACTION_ID.SESSION_OPEN,
    category: "session",
    description: "Open an ORGII agent session in the IDE",
    params: sessionIdParams,
    layer: "action",
    tags: ["session", "agent", "open", "navigate"],
    examples: ["open a session"],
  },
  async (params) => {
    await SessionService.open(params);
    return { success: true, message: `Opened ${params.sessionId}` };
  }
);

export const sessionMerge = defineZodAction(
  {
    id: ACTION_ID.SESSION_MERGE,
    category: "session",
    description: "Merge a completed session worktree branch",
    params: sessionIdParams.extend({
      strategy: z.enum(["auto", "leave", "ff"]).optional(),
    }),
    layer: "action",
    tags: ["session", "agent", "merge", "worktree"],
    examples: ["merge a session"],
  },
  async (params) => {
    const result = await SessionService.merge(params);
    return {
      success: true,
      message: result.merged
        ? `Merged ${params.sessionId}`
        : `Merge did not complete for ${params.sessionId}`,
      data: result,
    };
  }
);

export const sessionPatch = defineZodAction(
  {
    id: ACTION_ID.SESSION_PATCH,
    category: "session",
    description: "Patch mutable ORGII session metadata such as display name",
    params: sessionIdParams.extend({
      name: z.string().min(1).optional(),
      model: z.string().optional(),
      accountId: z.string().optional(),
      agentExecMode: z.string().optional(),
    }),
    layer: "action",
    tags: ["session", "agent", "patch", "rename"],
    examples: ["rename a session", "patch session metadata"],
  },
  async (params) => {
    const { sessionId, ...patch } = params;
    await rpc.sessionAggregate.patch({ sessionId, patch });
    return { success: true, message: `Patched ${sessionId}` };
  }
);

export const sessionUploadFile = defineZodAction(
  {
    id: ACTION_ID.SESSION_UPLOAD_FILE,
    category: "session",
    description: "Upload a file to a session context if supported",
    params: sessionIdParams.extend({ filePath: z.string().min(1) }),
    layer: "action",
    tags: ["session", "agent", "file", "upload"],
    examples: ["upload file to session"],
  },
  async () => ({
    success: false,
    message: "Uploading files to sessions is not currently supported by the ORGII frontend service",
  })
);

export const sessionZodActions = [
  sessionCreate,
  sessionList,
  sessionGetStatus,
  sessionSendMessage,
  sessionAnswerQuestion,
  sessionPause,
  sessionResume,
  sessionCancel,
  sessionOpen,
  sessionUploadFile,
  sessionMerge,
  sessionPatch,
];

export const sessionActionRegistration =
  defineAppActionRegistration(sessionZodActions);
