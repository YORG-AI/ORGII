import { makeSessionEvent } from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

export function makeReadFileItem(filePath: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "read_file",
    args: { file_path: filePath },
    result: {
      output: {
        success: { content: `content of ${filePath}`, path: filePath },
      },
    },
  });
}
export function makeEditFileItem(filePath: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "edit_file",
    uiCanonical: "edit_file",
    args: { file_path: filePath, old_string: "before", new_string: "after" },
    result: { success: true, file_path: filePath },
  });
}

export function makeDeleteFileItem(filePath: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "delete_file",
    uiCanonical: "delete_file",
    args: { file_path: filePath },
    result: { success: true, file_path: filePath },
  });
}

export function makeBrowserItem(action = "navigate") {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "browser",
    args: { action, url: "https://example.com" },
    result: { output: { success: { screenshot: "base64..." } } },
  });
}

export function makeShellItem(command: string, exitCode = 0) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "run_shell",
    args: { command },
    result: {
      output: {
        success: { command, stdout: `output of ${command}`, exitCode },
      },
    },
  });
}

export function makeAwaitItem(jobKind: "shell" | "subagent", handle: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "await_output",
    uiCanonical: "await_output",
    args: { command: "wait_for", handles: [handle] },
    result: {
      output: `awaitMeta::${JSON.stringify({
        count: 1,
        items: [{ handle, jobKind, status: "succeeded" }],
      })}`,
    },
  });
}

export function makeInspectTerminalsItem() {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "inspect_terminals",
    args: { action: "read_output", session_id: "terminal-1" },
    result: { success: true },
  });
}

export function makeSearchItem(query: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "code_search",
    args: { query },
    result: {
      matches: [{ file: "test.ts", line: 1, content: query }],
      total: 1,
    },
  });
}

export function makeListDirItem(directory: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "list_directory",
    args: { directory },
    result: {
      output: {
        success: {
          directoryTreeRoot: {
            absPath: directory,
            childrenDirs: [],
            childrenFiles: [],
          },
        },
      },
    },
  });
}

export function makeCliAliasItem(
  functionName: string,
  uiCanonical: string,
  args: Record<string, unknown>
) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: functionName,
    uiCanonical,
    args,
    result: { success: true, content: "ok" },
  });
}
