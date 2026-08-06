import { expect, it, vi } from "vitest";

import { ADE_MANAGER_AGENT_NAME, ADE_MANAGER_SESSION_NAME } from "./constants";
import { registerAdeManagerSession } from "./utils";

const mocks = vi.hoisted(() => ({
  registerCreatedSession: vi.fn(),
}));

vi.mock("@src/store/session/sessionAtom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/store/session/sessionAtom")>()),
  registerCreatedSession: mocks.registerCreatedSession,
}));

it("registers a newly launched ADE Manager session through the shared boundary", () => {
  registerAdeManagerSession({
    sessionId: "sdeagent-ade-manager",
    category: "rust_agent",
    name: "",
    status: "running",
    createdAt: "2026-08-05T12:00:00.000Z",
    userInput: "Manage ORGII",
    background: false,
  });

  expect(mocks.registerCreatedSession).toHaveBeenCalledOnce();
  expect(mocks.registerCreatedSession).toHaveBeenCalledWith(
    expect.objectContaining({
      session_id: "sdeagent-ade-manager",
      name: ADE_MANAGER_SESSION_NAME,
      agentDefinitionId: "builtin:agent-architect",
      agentDisplayName: ADE_MANAGER_AGENT_NAME,
    })
  );
});
