// orgii-session-provenance.js
// ORGII managed OpenCode plugin. Marker: --session-provenance-hook
// On every file-tool execution it pipes a JSON provenance record to an external
// binary's stdin. Do not edit by hand; this file is managed by the ORGII installer.
//
// Install location (global): ~/.config/opencode/plugin/orgii-session-provenance.js
// OpenCode auto-discovers *.js/*.ts under {plugin,plugins}/ in each config dir.
import { spawn } from "node:child_process";

// Absolute path to the ORGII binary. The installer rewrites this placeholder.
const BINARY = "__ORGII_BINARY__";

// OpenCode built-in tool ids that touch files. Names come from Tool.define(<id>).
const FILE_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "patch",
  "glob",
  "grep",
  "list",
  "bash",
]);

/**
 * OpenCode v1 plugin: a named export whose value is
 *   (input: PluginInput, options?) => Promise<Hooks>
 * PluginInput = { client, project, directory, worktree, serverUrl, $, ... }
 * We capture `directory` (absolute project/working dir) as cwd at init.
 */
export const OrgiiSessionProvenance = async ({ directory }) => {
  const cwd = directory;

  const emit = (payload) => {
    // Fire-and-forget. Must never throw and must never break the tool call.
    try {
      const child = spawn(BINARY, ["--session-provenance-hook", "opencode"], {
        cwd,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      // Swallow spawn/pipe errors (missing binary, EPIPE, etc.).
      child.on("error", () => {});
      if (child.stdin) {
        child.stdin.on("error", () => {});
        try {
          child.stdin.write(JSON.stringify(payload));
          child.stdin.end();
        } catch {
          /* ignore */
        }
      }
      // Do not keep the OpenCode event loop alive waiting on the child.
      if (typeof child.unref === "function") child.unref();
    } catch {
      /* ignore: provenance must be best-effort */
    }
  };

  // Live-status throttle: message-part streaming can fire dozens of events
  // per second; one Working heartbeat per session per interval is plenty.
  const MESSAGE_PART_THROTTLE_MS = 2000;
  const lastMessagePartAt = new Map();

  const emitStatus = (sessionID, eventName) => {
    if (!sessionID) return;
    emit({
      session_id: sessionID,
      cwd,
      hook_event_name: eventName,
    });
  };

  return {
    // input:  { tool, sessionID, callID, args }
    // output: { title, output, metadata }
    "tool.execute.after": async (input, _output) => {
      try {
        const toolName = input && input.tool;
        if (!toolName || !FILE_TOOLS.has(toolName)) return;
        const toolInput =
          input && input.args && typeof input.args === "object"
            ? input.args
            : {};
        emit({
          session_id: input.sessionID,
          cwd,
          tool_name: toolName, // OpenCode tool id, e.g. "read" / "edit" / "write"
          tool_input: toolInput, // parsed tool args; includes filePath when present
          hook_event_name: "PostToolUse",
          tool_use_id: input.callID,
        });
      } catch {
        /* never throw from a hook */
      }
    },
    // Live-status lifecycle: OpenCode has no native hooks vocabulary, so the
    // plugin synthesizes hook_event_name values the ORGII status normalizer
    // maps (SessionBusy/MessagePart → working, PermissionRequest → waiting,
    // SessionIdle → done, SessionError → failed).
    event: async ({ event }) => {
      try {
        if (!event || typeof event.type !== "string") return;
        const properties = event.properties || {};
        const sessionID =
          properties.sessionID ||
          (properties.info && properties.info.sessionID) ||
          (properties.info && properties.info.id) ||
          (properties.part && properties.part.sessionID);
        switch (event.type) {
          case "session.idle":
            emitStatus(sessionID, "SessionIdle");
            break;
          case "session.error":
            emitStatus(sessionID, "SessionError");
            break;
          case "permission.updated":
          case "permission.ask":
            emitStatus(sessionID, "PermissionRequest");
            break;
          case "message.updated":
          case "message.part.updated": {
            if (!sessionID) return;
            const now = Date.now();
            const last = lastMessagePartAt.get(sessionID) || 0;
            if (now - last < MESSAGE_PART_THROTTLE_MS) return;
            lastMessagePartAt.set(sessionID, now);
            if (lastMessagePartAt.size > 64) lastMessagePartAt.clear();
            emitStatus(sessionID, "MessagePart");
            break;
          }
          default:
            break;
        }
      } catch {
        /* never throw from a hook */
      }
    },
  };
};
