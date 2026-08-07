import { describe, expect, it } from "vitest";

import {
  COMPONENT_LOADERS,
  CONTEXT_CONFIG,
  chatRequiresItemIndex,
  chatShowsStatusLine,
  getAllEventTypes,
  getChatContextConfig,
  getChatLazyComponent,
  getEventsByCategory,
  isRegistered,
  resolveEventType,
  supportsContext,
} from "../events/index";

// ============================================
// COMPONENT_LOADERS
// ============================================

describe("COMPONENT_LOADERS", () => {
  const EXPECTED_EVENT_TYPES = [
    "read_file",
    "edit_file",
    "delete_file",
    "list_dir",
    "tool_search",
    "run_shell",
    "await_output",
    "inspect_terminals",
    "code_search",
    "web_search",
    "glob_file_search",
    "org_send_message",
    "plan_approval",
    "agent_message",
    "thinking",
    "user",
    "context_compacted",
    "ask_user_questions",
    "ask_user_permissions",
    "subagent",
    "suggest_mode_switch",
    "manage_todo",
    "task_create",
    "task_update",
    "task_list",
    "task_get",
    "browser",
    "internal_browser",
    "mcp_tool",
    "turn_summary",
    "worktree",
    "setup_repo",
    "rate_limit_hint",
    "tool_call",
  ] as const;

  it("has entries for all expected event types", () => {
    for (const eventType of EXPECTED_EVENT_TYPES) {
      expect(COMPONENT_LOADERS).toHaveProperty(eventType);
    }
  });

  it("each entry is a function", () => {
    for (const eventType of EXPECTED_EVENT_TYPES) {
      expect(typeof COMPONENT_LOADERS[eventType]).toBe("function");
    }
  });

  it("has exactly the expected entries", () => {
    expect(Object.keys(COMPONENT_LOADERS)).toHaveLength(
      EXPECTED_EVENT_TYPES.length
    );
  });
});

// ============================================
// CONTEXT_CONFIG
// ============================================

describe("CONTEXT_CONFIG", () => {
  it("has a matching key for every COMPONENT_LOADERS entry", () => {
    const loaderKeys = Object.keys(COMPONENT_LOADERS);
    const configKeys = Object.keys(CONTEXT_CONFIG);

    for (const key of loaderKeys) {
      expect(configKeys).toContain(key);
    }
  });

  it("read_file has chat.showStatusLine=true", () => {
    expect(CONTEXT_CONFIG["read_file"]?.chat?.showStatusLine).toBe(true);
  });

  it("read_file has simulator.supportsFullscreen=true", () => {
    expect(CONTEXT_CONFIG["read_file"]?.simulator?.supportsFullscreen).toBe(
      true
    );
  });

  it("run_shell has chat.showStatusLine=false", () => {
    expect(CONTEXT_CONFIG["run_shell"]?.chat?.showStatusLine).toBe(false);
  });

  it("edit_file has simulator.supportsSplitView=true", () => {
    expect(CONTEXT_CONFIG["edit_file"]?.simulator?.supportsSplitView).toBe(
      true
    );
  });

  it("edit_file has simulator.supportsTypewriter=true", () => {
    expect(CONTEXT_CONFIG["edit_file"]?.simulator?.supportsTypewriter).toBe(
      true
    );
  });

  it("agent_message has chat.requiresItemIndex=true", () => {
    expect(CONTEXT_CONFIG["agent_message"]?.chat?.requiresItemIndex).toBe(true);
  });

  it("thinking has chat.showStatusLine=false", () => {
    expect(CONTEXT_CONFIG["thinking"]?.chat?.showStatusLine).toBe(false);
  });

  it("tool_call has chat and simulator fallback config", () => {
    expect(CONTEXT_CONFIG["tool_call"]?.chat).toBeDefined();
    expect(CONTEXT_CONFIG["tool_call"]?.simulator).toEqual({
      supportsSplitView: false,
      supportsFullscreen: false,
    });
  });

  it("every config key maps back to COMPONENT_LOADERS", () => {
    const configKeys = Object.keys(CONTEXT_CONFIG);
    const loaderKeys = Object.keys(COMPONENT_LOADERS);

    for (const key of configKeys) {
      expect(loaderKeys).toContain(key);
    }
  });
});

// ============================================
// resolveEventType
// ============================================

describe("resolveEventType", () => {
  it("resolves CLI alias 'Read' to 'read_file'", () => {
    expect(resolveEventType("Read")).toBe("read_file");
  });

  it("resolves CLI alias 'Shell' to 'run_shell'", () => {
    expect(resolveEventType("Shell")).toBe("run_shell");
  });

  it("resolves CLI alias 'Edit' to 'edit_file'", () => {
    expect(resolveEventType("Edit")).toBe("edit_file");
  });

  it("resolves CLI alias 'Grep' to 'code_search'", () => {
    expect(resolveEventType("Grep")).toBe("code_search");
  });

  it("passes through canonical name 'read_file' unchanged", () => {
    expect(resolveEventType("read_file")).toBe("read_file");
  });

  it("passes through canonical name 'agent_message' unchanged", () => {
    expect(resolveEventType("agent_message")).toBe("agent_message");
  });

  it("passes through canonical name 'thinking' unchanged", () => {
    expect(resolveEventType("thinking")).toBe("thinking");
  });

  it("passes through unknown names unchanged", () => {
    expect(resolveEventType("some_unknown_tool")).toBe("some_unknown_tool");
  });

  it("passes through empty string unchanged", () => {
    expect(resolveEventType("")).toBe("");
  });

  it("resolves case-sensitive aliases (READ vs Read)", () => {
    expect(resolveEventType("READ")).toBe("read_file");
    expect(resolveEventType("read")).toBe("read_file");
  });
});

// ============================================
// isRegistered
// ============================================

describe("isRegistered", () => {
  it("returns true for all COMPONENT_LOADERS keys", () => {
    const loaderKeys = Object.keys(COMPONENT_LOADERS);
    for (const key of loaderKeys) {
      expect(isRegistered(key)).toBe(true);
    }
  });

  it("returns true for CLI alias 'Read'", () => {
    expect(isRegistered("Read")).toBe(true);
  });

  it("returns true for CLI alias 'Shell'", () => {
    expect(isRegistered("Shell")).toBe(true);
  });

  it("returns true for CLI alias 'Edit'", () => {
    expect(isRegistered("Edit")).toBe(true);
  });

  it("returns true for CLI alias 'Grep'", () => {
    expect(isRegistered("Grep")).toBe(true);
  });

  it("returns true for CLI alias 'Glob'", () => {
    expect(isRegistered("Glob")).toBe(true);
  });

  it("returns false for unknown tool 'nonexistent_tool'", () => {
    expect(isRegistered("nonexistent_tool")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isRegistered("")).toBe(false);
  });
});

// ============================================
// getAllEventTypes
// ============================================

describe("getAllEventTypes", () => {
  it("returns an array", () => {
    const allTypes = getAllEventTypes();
    expect(Array.isArray(allTypes)).toBe(true);
  });

  it("contains all COMPONENT_LOADERS keys", () => {
    const allTypes = getAllEventTypes();
    const loaderKeys = Object.keys(COMPONENT_LOADERS);

    for (const key of loaderKeys) {
      expect(allTypes).toContain(key);
    }
  });

  it("contains CLI alias keys like Read, Shell, Edit", () => {
    const allTypes = getAllEventTypes();

    expect(allTypes).toContain("Read");
    expect(allTypes).toContain("Shell");
    expect(allTypes).toContain("Edit");
    expect(allTypes).toContain("Grep");
    expect(allTypes).toContain("Glob");
  });

  it("has length greater than COMPONENT_LOADERS key count", () => {
    const allTypes = getAllEventTypes();
    const loaderKeyCount = Object.keys(COMPONENT_LOADERS).length;

    expect(allTypes.length).toBeGreaterThan(loaderKeyCount);
  });

  it("contains no duplicates", () => {
    const allTypes = getAllEventTypes();
    const uniqueTypes = new Set(allTypes);
    expect(uniqueTypes.size).toBe(allTypes.length);
  });
});

// ============================================
// getEventsByCategory
// ============================================

describe("getEventsByCategory", () => {
  it("'file' category contains file-related event types", () => {
    const fileEvents = getEventsByCategory("file");

    expect(fileEvents).toContain("read_file");
    expect(fileEvents).toContain("edit_file");
    expect(fileEvents).toContain("delete_file");
    expect(fileEvents).toContain("list_dir");
  });

  it("'terminal' category contains run_shell", () => {
    const terminalEvents = getEventsByCategory("terminal");

    expect(terminalEvents).toContain("run_shell");
  });

  it("'explore' category contains search-related event types", () => {
    const searchEvents = getEventsByCategory("explore");

    expect(searchEvents).toContain("code_search");
    expect(searchEvents).toContain("web_search");
    expect(searchEvents).toContain("glob_file_search");
  });

  it("'conversation' category contains conversation event types", () => {
    const conversationEvents = getEventsByCategory("conversation");

    expect(conversationEvents).toContain("agent_message");
    expect(conversationEvents).toContain("thinking");
    expect(conversationEvents).toContain("user");
    expect(conversationEvents).toContain("ask_user_questions");
  });

  it("returns non-empty arrays for known categories", () => {
    expect(getEventsByCategory("file").length).toBeGreaterThan(0);
    expect(getEventsByCategory("terminal").length).toBeGreaterThan(0);
    expect(getEventsByCategory("explore").length).toBeGreaterThan(0);
    expect(getEventsByCategory("conversation").length).toBeGreaterThan(0);
  });

  it("'approval' category contains ask_user_permissions", () => {
    const approvalEvents = getEventsByCategory("approval");
    expect(approvalEvents).toContain("ask_user_permissions");
  });

  it("returns only COMPONENT_LOADERS keys (no aliases)", () => {
    const fileEvents = getEventsByCategory("file");
    const loaderKeys = Object.keys(COMPONENT_LOADERS);

    for (const eventType of fileEvents) {
      expect(loaderKeys).toContain(eventType);
    }
  });
});

// ============================================
// getChatContextConfig
// ============================================

describe("getChatContextConfig", () => {
  it("returns correct config for agent_message", () => {
    const config = getChatContextConfig("agent_message");

    expect(config).not.toBeNull();
    expect(config?.requiresItemIndex).toBe(true);
    expect(config?.showStatusLine).toBe(true);
  });

  it("returns correct config for read_file", () => {
    const config = getChatContextConfig("read_file");

    expect(config).not.toBeNull();
    expect(config?.showStatusLine).toBe(true);
    expect(config?.requiresItemIndex).toBe(false);
  });

  it("returns correct config for thinking", () => {
    const config = getChatContextConfig("thinking");

    expect(config).not.toBeNull();
    expect(config?.showStatusLine).toBe(false);
  });

  it("returns null for unknown events", () => {
    const config = getChatContextConfig("totally_unknown_event");
    expect(config).toBeNull();
  });

  it("resolves CLI aliases before lookup", () => {
    const config = getChatContextConfig("Read");

    expect(config).not.toBeNull();
    expect(config?.showStatusLine).toBe(true);
  });

  it("returns correct config for run_shell", () => {
    const config = getChatContextConfig("run_shell");

    expect(config).not.toBeNull();
    expect(config?.showStatusLine).toBe(false);
  });
});

// ============================================
// chatShowsStatusLine / chatRequiresItemIndex
// ============================================

describe("chatShowsStatusLine", () => {
  it("returns true for read_file", () => {
    expect(chatShowsStatusLine("read_file")).toBe(true);
  });

  it("returns false for thinking", () => {
    expect(chatShowsStatusLine("thinking")).toBe(false);
  });

  it("returns true (default) for unknown event", () => {
    expect(chatShowsStatusLine("unknown_event")).toBe(true);
  });

  it("returns true for edit_file", () => {
    expect(chatShowsStatusLine("edit_file")).toBe(true);
  });

  it("returns false for run_shell", () => {
    expect(chatShowsStatusLine("run_shell")).toBe(false);
  });
});

describe("chatRequiresItemIndex", () => {
  it("returns true for agent_message", () => {
    expect(chatRequiresItemIndex("agent_message")).toBe(true);
  });

  it("returns false for read_file", () => {
    expect(chatRequiresItemIndex("read_file")).toBe(false);
  });

  it("returns false (default) for unknown event", () => {
    expect(chatRequiresItemIndex("unknown_event")).toBe(false);
  });

  it("returns false for thinking", () => {
    expect(chatRequiresItemIndex("thinking")).toBe(false);
  });

  it("returns false for edit_file", () => {
    expect(chatRequiresItemIndex("edit_file")).toBe(false);
  });
});

// ============================================
// supportsContext
// ============================================

describe("supportsContext", () => {
  it("returns true for known canonical event types", () => {
    expect(supportsContext("read_file")).toBe(true);
    expect(supportsContext("edit_file")).toBe(true);
    expect(supportsContext("agent_message")).toBe(true);
    expect(supportsContext("thinking")).toBe(true);
    expect(supportsContext("tool_call")).toBe(true);
  });

  it("returns true for CLI aliases that resolve to known types", () => {
    expect(supportsContext("Read")).toBe(true);
    expect(supportsContext("Shell")).toBe(true);
    expect(supportsContext("Edit")).toBe(true);
  });

  it("returns false for unknown event types", () => {
    expect(supportsContext("nonexistent_tool")).toBe(false);
    expect(supportsContext("totally_made_up")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(supportsContext("")).toBe(false);
  });
});

// ============================================
// getChatLazyComponent
// ============================================

describe("getChatLazyComponent", () => {
  it("returns an object for known event types", () => {
    const component = getChatLazyComponent("read_file");
    expect(component).toBeDefined();
    expect(typeof component).toBe("object");
  });

  it("returns the same instance on second call (cache)", () => {
    const first = getChatLazyComponent("edit_file");
    const second = getChatLazyComponent("edit_file");
    expect(first).toBe(second);
  });

  it("returns a component even for unknown types (fallback to tool_call)", () => {
    const component = getChatLazyComponent("completely_unknown_event_type");
    expect(component).toBeDefined();
    expect(typeof component).toBe("object");
  });

  it("returns different instances for different event types", () => {
    const readComponent = getChatLazyComponent("read_file");
    const editComponent = getChatLazyComponent("agent_message");
    expect(readComponent).not.toBe(editComponent);
  });

  it("returns a lazy component with $$typeof property", () => {
    const component = getChatLazyComponent("thinking");
    expect(component).toHaveProperty("$$typeof");
  });

  it("creates separate lazy instances for different unknown types", () => {
    const unknownFirst = getChatLazyComponent("mystery_tool_aaa");
    const unknownSecond = getChatLazyComponent("mystery_tool_bbb");
    expect(unknownFirst).not.toBe(unknownSecond);
  });

  it("caches even unknown type lazy components on repeated calls", () => {
    const first = getChatLazyComponent("mystery_tool_cached");
    const second = getChatLazyComponent("mystery_tool_cached");
    expect(first).toBe(second);
  });
});
