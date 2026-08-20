import { describe, expect, it } from "vitest";

import * as actionRegistry from "@src/engines/ChatPanel/ChatHistory/ActionRegistry";
import * as registryBarrel from "@src/engines/SessionCore/rendering/registry";
import * as contextConfig from "@src/engines/SessionCore/rendering/registry/events/contextConfig";
import * as eventsIndex from "@src/engines/SessionCore/rendering/registry/events/index";
import * as registryAccessors from "@src/engines/SessionCore/rendering/registry/registryAccessors";

/**
 * `events/contextConfig.ts` is the pure-metadata half of the event registry,
 * split out so the chat-projection worker can read chat config without the
 * renderer loaders. These checks make sure the split stays a pure move: every
 * public entry point still hands out the *same* functions/objects.
 */
describe("registry contextConfig boundary", () => {
  it("events/index re-exports the context config unchanged", () => {
    expect(eventsIndex.CONTEXT_CONFIG).toBe(contextConfig.CONTEXT_CONFIG);
    expect(eventsIndex.getChatContextConfig).toBe(
      contextConfig.getChatContextConfig
    );
    expect(eventsIndex.chatShowsStatusLine).toBe(
      contextConfig.chatShowsStatusLine
    );
    expect(eventsIndex.chatRequiresItemIndex).toBe(
      contextConfig.chatRequiresItemIndex
    );
  });

  it("registryAccessors and the barrel expose the same action-config helpers", () => {
    expect(registryAccessors.getActionConfig).toBe(
      contextConfig.getActionConfig
    );
    expect(registryAccessors.shouldShowStatusLine).toBe(
      contextConfig.shouldShowStatusLine
    );
    expect(registryAccessors.requiresItemIndex).toBe(
      contextConfig.requiresItemIndex
    );
    expect(registryBarrel.getActionConfig).toBe(contextConfig.getActionConfig);
    expect(registryBarrel.CONTEXT_CONFIG).toBe(contextConfig.CONTEXT_CONFIG);
  });

  it("ActionRegistry (worker-side entry) resolves the same helpers", () => {
    expect(actionRegistry.getActionConfig).toBe(contextConfig.getActionConfig);
    expect(actionRegistry.shouldShowStatusLine).toBe(
      contextConfig.shouldShowStatusLine
    );
    expect(actionRegistry.requiresItemIndex).toBe(
      contextConfig.requiresItemIndex
    );
  });

  it("action config answers match the context table", () => {
    expect(contextConfig.getActionConfig("read_file")).toEqual(
      contextConfig.CONTEXT_CONFIG.read_file.chat
    );
    expect(contextConfig.shouldShowStatusLine("read_file")).toBe(true);
    expect(contextConfig.requiresItemIndex("read_file")).toBe(false);
    // Unknown types fall back to the permissive defaults.
    expect(contextConfig.getActionConfig("definitely_not_a_tool")).toBeNull();
    expect(contextConfig.shouldShowStatusLine("definitely_not_a_tool")).toBe(
      true
    );
    expect(contextConfig.requiresItemIndex("definitely_not_a_tool")).toBe(
      false
    );
  });
});
