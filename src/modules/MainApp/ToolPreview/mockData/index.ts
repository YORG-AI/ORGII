import type {
  EventDisplayStatus,
  SessionEvent,
} from "@src/engines/SessionCore/core/types";
import { getCliUiCanonical } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { createLogger } from "@src/hooks/logger";

import { resolveCommandPreviewOverride } from "./commandPreviewOverrides";
import { MOCK_EVENT_DATA } from "./events";
import { generateMockId } from "./shared";

const log = createLogger("Playground sync");

export { MOCK_EVENT_DATA } from "./events";
export {
  MOCK_ACTIVE_PROCESSES,
  MOCK_FILE_CHANGES,
  MOCK_QUEUED_MESSAGES,
} from "./playgroundMocks";
export {
  MOCK_MANAGE_TODO_12_ITEMS,
  SUBAGENT_PLAYGROUND_PRESETS,
} from "./shared";

const INTERNAL_MOCK_KEYS = new Set<string>();

export function getAvailableEventTypes(): string[] {
  return Object.keys(MOCK_EVENT_DATA).filter(
    (key) => !INTERNAL_MOCK_KEYS.has(key)
  );
}

function createFreshMockData(eventType: string): SessionEvent | null {
  const template = MOCK_EVENT_DATA[eventType];
  if (!template) return null;

  const id = generateMockId();
  return {
    ...template,
    chunk_id: id,
    id,
    createdAt: new Date().toISOString(),
  };
}

export function createPlaygroundEventForToolName(
  toolName: string,
  status: EventDisplayStatus
): SessionEvent {
  const direct = createFreshMockData(toolName);
  if (direct) {
    return { ...direct, functionName: toolName, displayStatus: status };
  }

  const uiCanonical = getCliUiCanonical(toolName);
  const canonical = createFreshMockData(uiCanonical);
  if (canonical) {
    return { ...canonical, functionName: toolName, displayStatus: status };
  }

  const id = generateMockId();
  return {
    chunk_id: id,
    id,
    sessionId: "mock-session-001",
    actionType: "tool_call",
    functionName: toolName,
    uiCanonical: "",
    args: {},
    result: { success: true },
    source: "assistant",
    displayText: "",
    displayStatus: status,
    displayVariant: "tool_call",
    activityStatus: "agent",
    createdAt: new Date().toISOString(),
  };
}

export function buildPlaygroundEventsForTypes(
  orderedTypes: string[],
  status: EventDisplayStatus
): SessionEvent[] {
  return orderedTypes.flatMap((eventType) => {
    const event = createFreshMockData(eventType);
    return event ? [{ ...event, displayStatus: status }] : [];
  });
}

export function buildPlaygroundEventsForRegistryToolNames(
  orderedNames: string[],
  status: EventDisplayStatus
): SessionEvent[] {
  return orderedNames.map((name) =>
    createPlaygroundEventForToolName(name, status)
  );
}

export function buildPlaygroundEventsForToolCommands(
  toolName: string,
  commands: string[],
  status: EventDisplayStatus
): SessionEvent[] {
  return commands.map((commandName) => {
    const base = createPlaygroundEventForToolName(toolName, status);
    const override = resolveCommandPreviewOverride(toolName, commandName);
    return {
      ...base,
      chunk_id: generateMockId(),
      id: generateMockId(),
      args: {
        ...base.args,
        action: commandName,
        ...override.args,
      },
      result: {
        ...base.result,
        ...override.result,
      },
    };
  });
}

if (process.env.NODE_ENV === "development") {
  import("@src/engines/SessionCore/rendering/registry/events")
    .then(({ COMPONENT_LOADERS, CONTEXT_CONFIG }) => {
      const mockKeys = new Set(Object.keys(MOCK_EVENT_DATA));
      const configKeys = new Set(Object.keys(CONTEXT_CONFIG));
      const missing: {
        key: string;
        missingMock: boolean;
        missingConfig: boolean;
      }[] = [];

      for (const key of Object.keys(COMPONENT_LOADERS)) {
        const missingMock = !mockKeys.has(key);
        const missingConfig = !configKeys.has(key);
        if (missingMock || missingConfig) {
          missing.push({ key, missingMock, missingConfig });
        }
      }

      if (missing.length > 0) {
        log.warn(
          "[Playground sync] The following event types are registered in COMPONENT_LOADERS " +
            "but are missing entries. Add them to keep Playground in sync:\n" +
            missing
              .map(({ key, missingMock, missingConfig }) => {
                const locations: string[] = [];
                if (missingMock)
                  locations.push("MOCK_EVENT_DATA (mockData/events)");
                if (missingConfig)
                  locations.push("CONTEXT_CONFIG (registry/events)");
                return `  • ${key}: missing in ${locations.join(" and ")}`;
              })
              .join("\n")
        );
      }
    })
    .catch(() => {
      // Hot reload can invalidate the lazy registry chunk during replacement.
    });
}
