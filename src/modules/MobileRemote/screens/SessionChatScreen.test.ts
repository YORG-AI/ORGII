// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TranscriptItem } from "../lib/transcriptReducer";
import { SessionChatScreen } from "./SessionChatScreen";

const mocks = vi.hoisted(() => ({
  context: {} as Record<string, unknown>,
  transcriptProps: null as Record<string, unknown> | null,
}));

vi.mock("../app", () => ({
  useMobileRemote: () => mocks.context,
}));

vi.mock("../components/MobileTopBar", () => ({
  MobileTopBar: () => null,
}));

vi.mock("../components/composer/MobileComposer", () => ({
  MobileComposer: () => null,
}));

vi.mock("../components/transcript/ChatTranscript", () => ({
  ChatTranscript: (props: Record<string, unknown>) => {
    mocks.transcriptProps = props;
    return React.createElement("div", { "data-testid": "chat-transcript" });
  },
}));

vi.mock("../components/transcript/RoundNavigator", () => ({
  RoundNavigator: () => null,
}));

vi.mock("@src/components/IconButton", () => ({
  IconButton: () => null,
}));

vi.mock("@src/components/PermissionPrompt", () => ({
  PermissionSheet: () => null,
}));

vi.mock("@src/icons", () => ({
  HugeiconsIcon: () => null,
  StopCircleIcon: {},
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const OPTIMISTIC_USER: TranscriptItem = {
  id: "mobile-user-turn-1",
  kind: "user",
  text: "Run the tests",
  optimistic: true,
  turnIntentId: "turn-1",
};

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    connection: {
      status: "connected",
      presence: "online",
      tier: "full",
    },
    transcriptItems: [OPTIMISTIC_USER],
    transcriptPhase: "ready",
    transcriptError: undefined,
    transcriptTruncated: false,
    transcriptRounds: [],
    transcriptRoundsComplete: true,
    selectedRoundId: null,
    activeRoundId: "local-pending:turn-1",
    sendStatus: {
      sessionId: "session-a",
      turnIntentId: "turn-1",
      phase: "accepted",
    },
    activePermission: null,
    permissionQueueDepth: 0,
    sessionModel: {
      config: {
        sessionId: "session-a",
        model: "claude-sonnet-4-5",
        modelEditable: true,
      },
      options: [],
      loading: false,
      patching: false,
    },
    setSessionModel: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
    respondPermission: vi.fn(),
    subscribeSession: vi.fn().mockResolvedValue(undefined),
    unsubscribeSession: vi.fn().mockResolvedValue(undefined),
    selectRound: vi.fn(),
    retrySelectedRound: vi.fn(),
    ...overrides,
  };
}

describe("SessionChatScreen Agent loading state", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.transcriptProps = null;
    mocks.context = createContext();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  async function renderScreen() {
    await act(async () => {
      root.render(
        React.createElement(SessionChatScreen, {
          sessionId: "session-a",
          sessionName: "Remote session",
        })
      );
    });
  }

  it("shows loading only until the current turn paints Agent output", async () => {
    await renderScreen();
    expect(mocks.transcriptProps?.waitingForAgent).toBe(true);

    mocks.context = createContext({
      transcriptItems: [
        OPTIMISTIC_USER,
        {
          id: "agent-turn-1",
          kind: "agent",
          text: "Working",
          streaming: true,
        } satisfies TranscriptItem,
      ],
    });
    await renderScreen();
    expect(mocks.transcriptProps?.waitingForAgent).toBe(false);

    mocks.context = createContext({
      sendStatus: {
        sessionId: "session-a",
        turnIntentId: "turn-1",
        phase: "failed",
      },
    });
    await renderScreen();
    expect(mocks.transcriptProps?.waitingForAgent).toBe(false);
  });
});
