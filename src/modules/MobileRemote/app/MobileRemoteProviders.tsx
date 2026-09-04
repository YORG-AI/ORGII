import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { PermissionSheetRequest } from "@src/components/PermissionPrompt";

import { buildMobileWsUrl } from "../connection/buildMobileWsUrl";
import {
  type MobileRpcClient,
  createMobileRpcClient,
  toMobileRpcError,
} from "../connection/mobileRpcClient";
import type {
  InitializeResult,
  MobileConnectionConfig,
  MobileConnectionState,
  MobileModelOption,
  MobileSendAttachment,
  MobileSessionModelConfig,
  MobileSessionModelState,
  MobileSessionRow,
} from "../connection/types";
import {
  DEMO_DESKTOP_NAME,
  DEMO_PERMISSION_REQUEST,
  DEMO_SESSIONS,
} from "../demo/demoFixtures";
import {
  type InteractionQueueState,
  type PermissionBusEnvelope,
  countPermissionRequests,
  dequeuePermissionRequest,
  peekPermissionRequest,
  reduceInteractionQueueFromBusEvent,
} from "../lib/interactionQueue";
import {
  type TranscriptLoadPhase,
  type TranscriptRoundResult,
  type TranscriptRoundSummary,
  type TranscriptSnapshotEnvelope,
  type TranscriptSubscribeResult,
  appendOptimisticUserMessage,
  applyLiveTranscriptSnapshot,
  applyTranscriptRoundResult,
  applyTranscriptSubscribeResult,
  beginTranscriptLoad,
  beginTranscriptRoundLoad,
  confirmOptimisticUserRound,
  createInitialTranscriptLoadState,
  failTranscriptLoad,
  failTranscriptRoundLoad,
  getSelectedTranscriptView,
  readyTranscriptLoadState,
  retrySelectedTranscriptRound,
  rollbackOptimisticUserMessage,
  selectTranscriptRound as selectTranscriptRoundState,
  selectedTranscriptRoundId,
} from "../lib/transcriptLoadState";
import {
  type TranscriptItem,
  demoTranscriptItems,
} from "../lib/transcriptReducer";
import { useMobileRemotePlatform } from "../platform";
import type { MobileRemoteRuntimePort } from "../platform/types";

const CONNECT_TIMEOUT_MS = 15_000;
const PAIRING_TIMEOUT_MS = 130_000;
const MAX_RECONNECT_SECONDS = 30;

const INITIAL_SESSION_MODEL_STATE: MobileSessionModelState = {
  config: null,
  options: [],
  loading: false,
  patching: false,
};

const DEMO_SESSION_MODEL: MobileSessionModelConfig = {
  sessionId: "fix-auth-tests",
  model: "claude-sonnet-4-5",
  accountId: "demo-account",
  modelEditable: true,
};

const DEMO_MODEL_OPTIONS: MobileModelOption[] = [
  {
    id: "claude-sonnet-4-5",
    accountId: "demo-account",
    accountLabel: "Demo Anthropic",
  },
  {
    id: "claude-opus-4-5",
    accountId: "demo-account",
    accountLabel: "Demo Anthropic",
  },
];

export interface MobileRemoteContextValue {
  connection: MobileConnectionState;
  sessions: MobileSessionRow[];
  transcriptItems: TranscriptItem[];
  transcriptPhase: TranscriptLoadPhase;
  transcriptError?: string;
  transcriptTruncated: boolean;
  transcriptRounds: TranscriptRoundSummary[];
  transcriptRoundsComplete: boolean;
  /** Null means follow the latest round as the index grows. */
  selectedRoundId: string | null;
  activeRoundId: string | null;
  sendStatus: MobileSendStatus | null;
  activePermission: PermissionSheetRequest | null;
  permissionQueueDepth: number;
  /** True while an answer is on the wire; the sheet must stay disabled. */
  permissionSubmitting: boolean;
  rpc: MobileRpcClient | null;
  connectionConfig: MobileConnectionConfig | null;
  connectLive: (config: MobileConnectionConfig) => Promise<void>;
  enterDemoMode: () => void;
  disconnect: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  subscribeSession: (sessionId: string) => Promise<void>;
  unsubscribeSession: () => Promise<void>;
  selectRound: (roundId: string | null) => void;
  retrySelectedRound: () => void;
  sendMessage: (
    sessionId: string,
    content: string,
    attachments?: MobileSendAttachment[]
  ) => Promise<void>;
  openSessionFileInDesktop: (
    sessionId: string,
    roundId: string,
    eventId: string,
    targetIndex: number
  ) => Promise<void>;
  respondPermission: (
    response: "allow" | "deny" | "always_allow"
  ) => Promise<void>;
  dismissPermissionHead: () => void;
  stopSession: (sessionId: string) => Promise<void>;
  sessionModel: MobileSessionModelState;
  refreshSessionModel: (sessionId: string) => Promise<void>;
  setSessionModel: (
    sessionId: string,
    option: MobileModelOption
  ) => Promise<void>;
}

export interface MobileSendStatus {
  sessionId: string;
  turnIntentId: string;
  phase:
    | "submitting"
    | "accepted"
    | "uncertain"
    | "completed"
    | "failed"
    | "cancelled";
  message?: string;
}

interface MobileTerminalSignal {
  sessionId: string;
  turnIntentId?: string;
  phase?: "completed" | "failed" | "cancelled";
  message?: string;
}

const MobileRemoteContext = createContext<MobileRemoteContextValue | null>(
  null
);

function isIndeterminateTransportError(error: unknown): boolean {
  const message = toMobileRpcError(error).message;
  return (
    message === "WebSocket closed" ||
    message === "WebSocket is not open" ||
    message === "RPC client closed" ||
    message.startsWith("RPC call timed out:")
  );
}

function waitForSocketOpen(
  socket: WebSocket,
  runtime: Pick<MobileRemoteRuntimePort, "setTimeout" | "clearTimeout">
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      runtime.clearTimeout(timeoutId);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket connection failed"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before connecting"));
    };
    const timeoutId = runtime.setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket connection timed out"));
    }, CONNECT_TIMEOUT_MS);
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}

function waitForPairingApproval(
  socket: WebSocket,
  client: MobileRpcClient,
  runtime: Pick<MobileRemoteRuntimePort, "setTimeout" | "clearTimeout">
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const cleanup = () => {
      runtime.clearTimeout(timeoutId);
      unsubscribe();
      socket.removeEventListener("close", onClose);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Connection closed before pairing was approved"));
    };
    const timeoutId = runtime.setTimeout(() => {
      cleanup();
      reject(new Error("Pairing confirmation expired"));
    }, PAIRING_TIMEOUT_MS);
    unsubscribe = client.onNotification((method) => {
      if (method === "pairing/approved") {
        cleanup();
        resolve();
      }
    });
    socket.addEventListener("close", onClose, { once: true });
  });
}

function reconnectDelay(attempt: number, random: () => number): number {
  const seconds = Math.min(
    MAX_RECONNECT_SECONDS,
    2 ** Math.min(Math.max(attempt - 1, 0), 5)
  );
  return seconds * 1_000 + Math.floor(random() * 500);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

function terminalSignalFromBusEvent(
  params: Record<string, unknown> | undefined
): MobileTerminalSignal | null {
  const envelope = record(params?.envelope);
  if (!envelope) return null;
  const type = firstString(envelope.type);
  const payload = record(envelope.payload);
  const event = record(payload?.event);
  const eventResult = record(event?.result);
  const sessionId = firstString(
    params?.sessionId,
    envelope.sessionId,
    envelope.session_id,
    payload?.sessionId,
    payload?.session_id,
    event?.sessionId,
    event?.session_id
  );
  if (!sessionId || !type) return null;
  const turnIntentId = firstString(
    envelope.turnIntentId,
    envelope.turn_intent_id,
    payload?.turnIntentId,
    payload?.turn_intent_id,
    event?.turnIntentId,
    event?.turn_intent_id,
    eventResult?.turnIntentId,
    eventResult?.turn_intent_id
  );

  if (type === "code_session.history_changed") {
    return {
      sessionId,
      turnIntentId,
      phase: envelope.status === "turn_settled" ? "completed" : undefined,
    };
  }
  if (type === "agent:streaming_complete") {
    return { sessionId, turnIntentId, phase: "completed" };
  }
  if (type !== "code_session.status_changed") return null;

  const status = firstString(envelope.status, payload?.status);
  if (status === "completed") {
    return { sessionId, turnIntentId, phase: "completed" };
  }
  if (status === "cancelled") {
    return { sessionId, turnIntentId, phase: "cancelled" };
  }
  if (status === "failed") {
    return {
      sessionId,
      turnIntentId,
      phase: "failed",
      message: firstString(
        envelope.errorMessage,
        envelope.error_message,
        payload?.errorMessage,
        payload?.error_message
      ),
    };
  }
  return null;
}

export interface MobileRemoteProvidersProps {
  children: React.ReactNode;
  /** Authenticated ORG2 Cloud subject; scopes all retained pairing state. */
  authUserId: string;
  relayUrl?: string;
  demoByDefault?: boolean;
  /** A freshly scanned QR must take precedence over a stored old desktop. */
  suppressInitialBootstrap?: boolean;
}

export function MobileRemoteProviders({
  children,
  authUserId,
  relayUrl,
  demoByDefault = true,
  suppressInitialBootstrap = false,
}: MobileRemoteProvidersProps) {
  const platform = useMobileRemotePlatform();
  const clientRef = useRef<MobileRpcClient | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const unsubscribeRpcRef = useRef<(() => void) | null>(null);
  const activeConfigRef = useRef<MobileConnectionConfig | null>(null);
  const generationRef = useRef(0);
  const sessionListGenerationRef = useRef(0);
  const subscriptionGenerationRef = useRef(0);
  const roundRequestGenerationRef = useRef(0);
  const refreshInFlightRef = useRef<{
    token: symbol;
    sessionId: string;
    client: MobileRpcClient;
  } | null>(null);
  const queuedRefreshSessionRef = useRef<string | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const connectionWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const refreshSubscribedSessionRef = useRef<(sessionId: string) => void>(
    () => undefined
  );
  const scheduleReconnectRef = useRef<
    (config: MobileConnectionConfig, generation: number) => void
  >(() => undefined);

  const [connection, setConnection] = useState<MobileConnectionState>({
    status: "disconnected",
    presence: "unknown",
    demoMode: demoByDefault && !suppressInitialBootstrap,
  });
  const [connectionConfig, setConnectionConfig] =
    useState<MobileConnectionConfig | null>(null);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const [sessions, setSessions] = useState<MobileSessionRow[]>([]);
  const [transcript, setTranscript] = useState(
    createInitialTranscriptLoadState
  );
  const [sendStatus, setSendStatus] = useState<MobileSendStatus | null>(null);
  const [interactionQueue, setInteractionQueue] =
    useState<InteractionQueueState>({ queue: [] });
  const [permissionSubmitting, setPermissionSubmitting] = useState(false);
  /** requestId of the answer currently on the wire, or null. */
  const permissionInFlightRef = useRef<string | null>(null);
  const [sessionModel, setSessionModelState] =
    useState<MobileSessionModelState>(INITIAL_SESSION_MODEL_STATE);
  const sessionModelRequestRef = useRef(0);

  const persistConnection = useCallback(
    (config: MobileConnectionConfig | null) => {
      const operation = connectionWriteChainRef.current.then(() =>
        platform.connection.save(authUserId, config)
      );
      connectionWriteChainRef.current = operation.catch(() => undefined);
      return operation;
    },
    [authUserId, platform.connection]
  );

  const requestSessionList = useCallback(async (client: MobileRpcClient) => {
    const requestGeneration = ++sessionListGenerationRef.current;
    const list = await client.call<{ sessions?: MobileSessionRow[] }>(
      "session/list"
    );
    if (
      requestGeneration !== sessionListGenerationRef.current ||
      clientRef.current !== client
    ) {
      return;
    }
    setSessions(list.sessions ?? []);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current != null) {
      platform.runtime.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, [platform.runtime]);

  const releaseTransport = useCallback((close: boolean) => {
    // Invalidate every in-flight subscribe/refresh from the old socket before
    // it can reject or resolve into the retained logical session state.
    subscriptionGenerationRef.current += 1;
    roundRequestGenerationRef.current += 1;
    refreshInFlightRef.current = null;
    queuedRefreshSessionRef.current = null;
    unsubscribeRpcRef.current?.();
    unsubscribeRpcRef.current = null;
    const client = clientRef.current;
    clientRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (close) {
      if (client) client.close();
      else socket?.close();
    }
  }, []);

  const enterDemoMode = useCallback(() => {
    generationRef.current += 1;
    sessionListGenerationRef.current += 1;
    clearReconnectTimer();
    activeConfigRef.current = null;
    setConnectionConfig(null);
    releaseTransport(true);
    setConnection({
      status: "connected",
      presence: "online",
      desktopName: DEMO_DESKTOP_NAME,
      tier: "full",
      capabilities: { roundHistory: true, openSessionFile: false },
      demoMode: true,
    });
    setSessions(DEMO_SESSIONS);
    const subscriptionGeneration = ++subscriptionGenerationRef.current;
    setTranscript(
      readyTranscriptLoadState(
        activeSessionRef.current ?? "demo",
        subscriptionGeneration,
        demoTranscriptItems()
      )
    );
    setSendStatus(null);
    setInteractionQueue({ queue: [] });
  }, [clearReconnectTimer, releaseTransport]);

  const handleRpcNotification = useCallback(
    (method: string, params: Record<string, unknown> | undefined) => {
      if (method === "relay/presence") {
        setConnection((prev) => ({
          ...prev,
          presence: params?.online === true ? "online" : "offline",
        }));
        return;
      }
      if (method === "orgii/event") {
        const envelope = params?.envelope as PermissionBusEnvelope | undefined;
        if (envelope) {
          setInteractionQueue((prev) =>
            reduceInteractionQueueFromBusEvent(prev, envelope)
          );
        }
        const terminal = terminalSignalFromBusEvent(params);
        if (terminal) {
          if (terminal.sessionId === activeSessionRef.current) {
            refreshSubscribedSessionRef.current(terminal.sessionId);
          }
          const terminalPhase = terminal.phase;
          if (terminalPhase && terminal.turnIntentId) {
            setSendStatus((current) =>
              current?.sessionId === terminal.sessionId &&
              current.turnIntentId === terminal.turnIntentId
                ? {
                    ...current,
                    phase: terminalPhase,
                    message: terminal.message,
                  }
                : current
            );
          }
        }
        return;
      }
      if (method === "orgii/snapshot") {
        if (params?.sessionId !== activeSessionRef.current) return;
        setTranscript((prev) =>
          applyLiveTranscriptSnapshot(
            prev,
            params as TranscriptSnapshotEnvelope
          )
        );
        if (params?.snapshotDelta === true && params.streaming === false) {
          refreshSubscribedSessionRef.current(String(params.sessionId));
        }
        return;
      }
      if (method === "session/send_status") {
        const sessionId =
          typeof params?.sessionId === "string" ? params.sessionId : "";
        const turnIntentId =
          typeof params?.turnIntentId === "string" ? params.turnIntentId : "";
        const status = typeof params?.status === "string" ? params.status : "";
        const roundId =
          typeof params?.roundId === "string" ? params.roundId.trim() : "";
        if (!sessionId || !turnIntentId) return;
        const phase =
          status === "completed"
            ? "completed"
            : status === "cancelled"
              ? "cancelled"
              : "failed";
        setSendStatus((current) =>
          current?.sessionId === sessionId &&
          current.turnIntentId === turnIntentId
            ? {
                ...current,
                phase,
                message:
                  typeof params?.message === "string"
                    ? params.message
                    : undefined,
              }
            : current
        );
        if (phase === "completed" && roundId) {
          setTranscript((current) =>
            confirmOptimisticUserRound(
              current,
              sessionId,
              turnIntentId,
              roundId
            )
          );
        } else if (phase === "failed" || phase === "cancelled") {
          setTranscript((current) =>
            rollbackOptimisticUserMessage(current, sessionId, turnIntentId)
          );
        }
        // A completed notification without roundId is deliberately not enough
        // to retire the local round. The provider history may still lag, and
        // guessing by directory position can bind a concurrent desktop turn.
        refreshSubscribedSessionRef.current(sessionId);
        return;
      }
      if (method === "session/list_changed") {
        const client = clientRef.current;
        if (client) {
          // Keep the previous successful list visible during invalidation.
          // A failed refresh is retried by the next change/reconnect/manual
          // refresh; the generation guard prevents an older reply winning.
          void requestSessionList(client).catch(() => undefined);
        }
      }
    },
    [requestSessionList]
  );

  const requestSessionSnapshot = useCallback(
    async (
      client: MobileRpcClient,
      sessionId: string,
      subscriptionGeneration: number
    ) => {
      try {
        const result = await client.call<TranscriptSubscribeResult>(
          "session/subscribe",
          { sessionId }
        );
        if (
          activeSessionRef.current !== sessionId ||
          subscriptionGenerationRef.current !== subscriptionGeneration
        ) {
          return;
        }
        setTranscript((prev) =>
          applyTranscriptSubscribeResult(
            prev,
            result,
            sessionId,
            subscriptionGeneration
          )
        );
      } catch (error) {
        setTranscript((prev) =>
          failTranscriptLoad(
            prev,
            sessionId,
            subscriptionGeneration,
            toMobileRpcError(error).message
          )
        );
        throw error;
      }
    },
    []
  );

  refreshSubscribedSessionRef.current = (sessionId: string) => {
    const client = clientRef.current;
    if (
      !client ||
      activeSessionRef.current !== sessionId ||
      connectionRef.current.presence !== "online"
    ) {
      return;
    }
    if (refreshInFlightRef.current) {
      queuedRefreshSessionRef.current = sessionId;
      return;
    }
    const token = Symbol("mobile-transcript-refresh");
    refreshInFlightRef.current = { token, sessionId, client };
    const subscriptionGeneration = ++subscriptionGenerationRef.current;
    setTranscript((current) =>
      beginTranscriptLoad(current, sessionId, subscriptionGeneration)
    );
    void requestSessionSnapshot(client, sessionId, subscriptionGeneration)
      .catch(() => undefined)
      .finally(() => {
        if (refreshInFlightRef.current?.token !== token) return;
        refreshInFlightRef.current = null;
        const queuedSessionId = queuedRefreshSessionRef.current;
        queuedRefreshSessionRef.current = null;
        if (queuedSessionId) {
          refreshSubscribedSessionRef.current(queuedSessionId);
        }
      });
  };

  const establishConnection = useCallback(
    async (config: MobileConnectionConfig, generation: number) => {
      const deviceLabel =
        config.deviceLabel?.trim() || platform.clientInfo.defaultDeviceLabel;
      const transportConfig = { ...config, deviceLabel };
      const socket = platform.connection.createSocket(
        buildMobileWsUrl(transportConfig)
      );
      let authenticated = false;
      let intentionalClose = false;
      socketRef.current = socket;

      try {
        await waitForSocketOpen(socket, platform.runtime);
        if (generation !== generationRef.current) {
          intentionalClose = true;
          socket.close();
          throw new Error("Connection was superseded");
        }

        const client = createMobileRpcClient(socket, platform.runtime);
        clientRef.current = client;
        unsubscribeRpcRef.current = client.onNotification(
          handleRpcNotification
        );
        if (config.pairingCode) {
          await waitForPairingApproval(socket, client, platform.runtime);
        }

        const init = await client.call<InitializeResult>("initialize", {
          protocolVersion: 1,
          clientInfo: {
            name: platform.clientInfo.name,
            version: platform.clientInfo.version,
          },
          capabilities: { interactions: ["permission"], streaming: true },
          deviceLabel,
        });
        if (generation !== generationRef.current) {
          intentionalClose = true;
          client.close();
          throw new Error("Connection was superseded");
        }

        authenticated = true;
        reconnectAttemptRef.current = 0;
        setConnection({
          status: "connected",
          presence: "online",
          desktopId: init.desktopId ?? config.desktopId,
          desktopName: init.desktopName ?? DEMO_DESKTOP_NAME,
          // Authorization is server-owned. An older/incomplete initialize
          // response must never silently upgrade the phone to write access.
          tier: init.tier ?? "read_only",
          capabilities: init.capabilities,
          demoMode: false,
        });
        await requestSessionList(client);
        if (activeSessionRef.current) {
          const sessionId = activeSessionRef.current;
          const subscriptionGeneration = ++subscriptionGenerationRef.current;
          setTranscript((prev) =>
            beginTranscriptLoad(prev, sessionId, subscriptionGeneration)
          );
          await requestSessionSnapshot(
            client,
            sessionId,
            subscriptionGeneration
          ).catch(() => undefined);
        }

        socket.addEventListener(
          "close",
          () => {
            if (
              intentionalClose ||
              !authenticated ||
              generation !== generationRef.current ||
              socketRef.current !== socket
            ) {
              return;
            }
            releaseTransport(false);
            setConnection((prev) => ({
              ...prev,
              status: "connecting",
              presence: "offline",
              error: undefined,
            }));
            scheduleReconnectRef.current(config, generation);
          },
          { once: true }
        );
      } catch (error) {
        intentionalClose = true;
        if (socketRef.current === socket) releaseTransport(true);
        throw error;
      }
    },
    [
      handleRpcNotification,
      platform.clientInfo,
      platform.connection,
      platform.runtime,
      releaseTransport,
      requestSessionList,
      requestSessionSnapshot,
    ]
  );

  const runReconnect = useCallback(
    async (config: MobileConnectionConfig, generation: number) => {
      if (generation !== generationRef.current || platform.runtime.isHidden()) {
        return;
      }
      setConnection((prev) => ({
        ...prev,
        status: "connecting",
        presence: "offline",
        error: undefined,
      }));
      try {
        await establishConnection(config, generation);
      } catch (error) {
        if (generation !== generationRef.current) return;
        setConnection((prev) => ({
          ...prev,
          status: "connecting",
          presence: "offline",
          error: toMobileRpcError(error),
        }));
        scheduleReconnectRef.current(config, generation);
      }
    },
    [establishConnection, platform.runtime]
  );

  const scheduleReconnect = useCallback(
    (config: MobileConnectionConfig, generation: number) => {
      clearReconnectTimer();
      if (generation !== generationRef.current || platform.runtime.isHidden()) {
        return;
      }
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = platform.runtime.setTimeout(
        () => {
          reconnectTimerRef.current = null;
          void runReconnect(config, generation);
        },
        reconnectDelay(reconnectAttemptRef.current, platform.runtime.random)
      );
    },
    [clearReconnectTimer, platform.runtime, runReconnect]
  );
  scheduleReconnectRef.current = scheduleReconnect;

  const connectLive = useCallback(
    async (config: MobileConnectionConfig) => {
      generationRef.current += 1;
      const generation = generationRef.current;
      clearReconnectTimer();
      releaseTransport(true);
      reconnectAttemptRef.current = 0;
      activeConfigRef.current = config;
      setConnectionConfig(config);
      await persistConnection(config);
      if (generation !== generationRef.current) {
        throw new Error("Connection was superseded");
      }
      setConnection((prev) => ({
        ...prev,
        status: "connecting",
        presence: "unknown",
        demoMode: false,
        error: undefined,
      }));
      try {
        await establishConnection(config, generation);
      } catch (error) {
        if (generation === generationRef.current) {
          setConnection({
            status: "error",
            presence: "offline",
            demoMode: false,
            error: toMobileRpcError(error),
          });
        }
        throw error;
      }
    },
    [
      clearReconnectTimer,
      establishConnection,
      persistConnection,
      releaseTransport,
    ]
  );

  const disconnect = useCallback(async () => {
    generationRef.current += 1;
    sessionListGenerationRef.current += 1;
    clearReconnectTimer();
    activeConfigRef.current = null;
    setConnectionConfig(null);
    releaseTransport(true);
    activeSessionRef.current = null;
    subscriptionGenerationRef.current += 1;
    setConnection({
      status: "disconnected",
      presence: "unknown",
      demoMode: false,
    });
    setSessions([]);
    setTranscript(createInitialTranscriptLoadState());
    setSendStatus(null);
    setInteractionQueue({ queue: [] });
    await persistConnection(null);
  }, [clearReconnectTimer, persistConnection, releaseTransport]);

  const refreshSessions = useCallback(async () => {
    if (connection.demoMode) {
      setSessions(DEMO_SESSIONS);
      return;
    }
    const client = clientRef.current;
    if (!client || connection.presence !== "online") return;
    await requestSessionList(client);
  }, [connection.demoMode, connection.presence, requestSessionList]);

  const requireWritableClient = useCallback((): MobileRpcClient => {
    const client = clientRef.current;
    if (
      !client ||
      connection.status !== "connected" ||
      connection.presence !== "online"
    ) {
      throw new Error("Desktop is offline");
    }
    if (connection.tier === "read_only") {
      throw new Error("This device has read-only access");
    }
    return client;
  }, [connection.presence, connection.status, connection.tier]);

  const refreshSessionModel = useCallback(async (sessionId: string) => {
    const requestGeneration = ++sessionModelRequestRef.current;
    setSessionModelState((prev) => ({
      ...prev,
      loading: true,
      error: undefined,
    }));
    const currentConnection = connectionRef.current;
    if (currentConnection.demoMode) {
      if (requestGeneration !== sessionModelRequestRef.current) return;
      setSessionModelState({
        config: { ...DEMO_SESSION_MODEL, sessionId },
        options: DEMO_MODEL_OPTIONS,
        loading: false,
        patching: false,
      });
      return;
    }
    const client = clientRef.current;
    if (!client || currentConnection.presence !== "online") {
      setSessionModelState((prev) => ({
        ...prev,
        loading: false,
        error: "Desktop is offline",
      }));
      return;
    }
    try {
      const [config, list] = await Promise.all([
        client.call<MobileSessionModelConfig>("session/config", { sessionId }),
        client.call<{ models?: MobileModelOption[] }>("models/list", {
          sessionId,
        }),
      ]);
      if (
        requestGeneration !== sessionModelRequestRef.current ||
        activeSessionRef.current !== sessionId
      ) {
        return;
      }
      setSessionModelState({
        config,
        options: list.models ?? [],
        loading: false,
        patching: false,
      });
    } catch (error) {
      if (requestGeneration !== sessionModelRequestRef.current) return;
      setSessionModelState((prev) => ({
        ...prev,
        loading: false,
        error: toMobileRpcError(error).message,
      }));
    }
  }, []);

  const setSessionModel = useCallback(
    async (sessionId: string, option: MobileModelOption) => {
      setSessionModelState((prev) => ({
        ...prev,
        patching: true,
        error: undefined,
      }));
      const currentConnection = connectionRef.current;
      if (currentConnection.demoMode) {
        setSessionModelState((prev) => ({
          ...prev,
          patching: false,
          config: prev.config
            ? {
                ...prev.config,
                sessionId,
                model: option.id,
                accountId: option.accountId,
              }
            : {
                sessionId,
                model: option.id,
                accountId: option.accountId,
                modelEditable: true,
              },
        }));
        return;
      }
      try {
        await requireWritableClient().call("session/patch", {
          sessionId,
          patch: {
            model: option.id,
            accountId: option.accountId || undefined,
          },
        });
        setSessionModelState((prev) => ({
          ...prev,
          patching: false,
          config: prev.config
            ? {
                ...prev.config,
                model: option.id,
                accountId: option.accountId,
              }
            : {
                sessionId,
                model: option.id,
                accountId: option.accountId,
                modelEditable: true,
              },
        }));
      } catch (error) {
        setSessionModelState((prev) => ({
          ...prev,
          patching: false,
          error: toMobileRpcError(error).message,
        }));
        throw error;
      }
    },
    [requireWritableClient]
  );

  const subscribeSession = useCallback(
    async (sessionId: string) => {
      activeSessionRef.current = sessionId;
      setSendStatus(null);
      const subscriptionGeneration = ++subscriptionGenerationRef.current;
      setTranscript((prev) =>
        beginTranscriptLoad(prev, sessionId, subscriptionGeneration)
      );
      const currentConnection = connectionRef.current;
      if (currentConnection.demoMode) {
        setTranscript(
          readyTranscriptLoadState(
            sessionId,
            subscriptionGeneration,
            demoTranscriptItems()
          )
        );
        await refreshSessionModel(sessionId);
        return;
      }
      const client = clientRef.current;
      if (!client || currentConnection.presence !== "online") {
        const error = new Error("Desktop is offline");
        setTranscript((prev) =>
          failTranscriptLoad(
            prev,
            sessionId,
            subscriptionGeneration,
            error.message
          )
        );
        throw error;
      }
      await requestSessionSnapshot(client, sessionId, subscriptionGeneration);
      await refreshSessionModel(sessionId);
    },
    [refreshSessionModel, requestSessionSnapshot]
  );

  const unsubscribeSession = useCallback(async () => {
    const sessionId = activeSessionRef.current;
    activeSessionRef.current = null;
    subscriptionGenerationRef.current += 1;
    sessionModelRequestRef.current += 1;
    setTranscript(createInitialTranscriptLoadState());
    setSendStatus(null);
    setSessionModelState(INITIAL_SESSION_MODEL_STATE);
    const currentConnection = connectionRef.current;
    if (currentConnection.demoMode || !sessionId) return;
    if (clientRef.current && currentConnection.presence === "online") {
      await clientRef.current.call("session/unsubscribe", { sessionId });
    }
  }, []);

  const selectRound = useCallback((roundId: string | null) => {
    setTranscript((prev) => selectTranscriptRoundState(prev, roundId));
  }, []);

  const retrySelectedRound = useCallback(() => {
    setTranscript((prev) => retrySelectedTranscriptRound(prev));
  }, []);

  const activeRoundId = selectedTranscriptRoundId(transcript);
  const activeRoundBody = activeRoundId
    ? transcript.bodies[activeRoundId]
    : undefined;

  useEffect(() => {
    const sessionId = transcript.sessionId;
    if (
      !sessionId ||
      !activeRoundId ||
      activeRoundBody?.phase !== "unloaded" ||
      connection.demoMode
    ) {
      return;
    }

    const requestGeneration = ++roundRequestGenerationRef.current;
    const sessionGeneration = transcript.generation;
    setTranscript((prev) =>
      beginTranscriptRoundLoad(
        prev,
        sessionId,
        activeRoundId,
        requestGeneration
      )
    );
    const client = clientRef.current;
    if (!client || connection.presence !== "online") {
      setTranscript((prev) =>
        failTranscriptRoundLoad(
          prev,
          sessionId,
          activeRoundId,
          sessionGeneration,
          requestGeneration,
          "Desktop is offline"
        )
      );
      return;
    }

    void client
      .call<TranscriptRoundResult>("session/round", {
        sessionId,
        roundId: activeRoundId,
      })
      .then((result) => {
        setTranscript((prev) =>
          applyTranscriptRoundResult(
            prev,
            result,
            sessionId,
            activeRoundId,
            sessionGeneration,
            requestGeneration
          )
        );
      })
      .catch((error) => {
        setTranscript((prev) =>
          failTranscriptRoundLoad(
            prev,
            sessionId,
            activeRoundId,
            sessionGeneration,
            requestGeneration,
            toMobileRpcError(error).message
          )
        );
      });
  }, [
    activeRoundBody?.phase,
    activeRoundId,
    connection.demoMode,
    connection.presence,
    transcript.generation,
    transcript.sessionId,
  ]);

  const sendMessage = useCallback(
    async (
      sessionId: string,
      content: string,
      attachments: MobileSendAttachment[] = []
    ) => {
      const trimmed = content.trim();
      if (!trimmed && attachments.length === 0) return;
      const turnIntentId = platform.runtime.randomUUID();
      const optimisticPreview =
        trimmed ||
        attachments
          .map((attachment) => attachment.fileName?.trim())
          .filter(Boolean)
          .join(", ") ||
        "Photo";
      setSendStatus({
        sessionId,
        turnIntentId,
        phase: "submitting",
      });
      setTranscript((prev) =>
        appendOptimisticUserMessage(
          prev,
          sessionId,
          turnIntentId,
          optimisticPreview
        )
      );
      if (connection.demoMode) {
        setInteractionQueue({
          queue: [{ ...DEMO_PERMISSION_REQUEST, sessionId }],
        });
        setSendStatus({
          sessionId,
          turnIntentId,
          phase: "completed",
        });
        return;
      }
      try {
        const selectedModel = sessionModel.config?.model;
        await requireWritableClient().call<{
          execution?: string;
        }>("session/send", {
          sessionId,
          content: trimmed,
          turnIntentId,
          turnIntentSource: "mobile_remote",
          attachments,
          ...(selectedModel ? { model: selectedModel } : {}),
        });
        setSendStatus((current) =>
          current?.sessionId === sessionId &&
          current.turnIntentId === turnIntentId &&
          current.phase === "submitting"
            ? { ...current, phase: "accepted" }
            : current
        );
      } catch (error) {
        const message = toMobileRpcError(error).message;
        const uncertain = isIndeterminateTransportError(error);
        if (!uncertain) {
          setTranscript((prev) =>
            rollbackOptimisticUserMessage(prev, sessionId, turnIntentId)
          );
        }
        setSendStatus((current) =>
          current?.sessionId === sessionId &&
          current.turnIntentId === turnIntentId
            ? {
                ...current,
                phase: uncertain ? "uncertain" : "failed",
                message,
              }
            : current
        );
        if (uncertain) return;
        throw error;
      }
    },
    [
      connection.demoMode,
      platform.runtime,
      requireWritableClient,
      sessionModel.config?.model,
    ]
  );

  const openSessionFileInDesktop = useCallback(
    async (
      sessionId: string,
      roundId: string,
      eventId: string,
      targetIndex: number
    ) => {
      if (!sessionId || !roundId || !eventId) return;
      if (connection.demoMode) {
        throw new Error("Desktop file navigation is unavailable in demo mode");
      }
      await requireWritableClient().call("session/open_file", {
        sessionId,
        roundId,
        eventId,
        targetIndex,
      });
    },
    [connection.demoMode, requireWritableClient]
  );

  const respondPermission = useCallback(
    async (response: "allow" | "deny" | "always_allow") => {
      const head = peekPermissionRequest(
        interactionQueue,
        transcript.sessionId
      );
      if (!head) return;
      // Single-flight: a second tap before the RPC settles would answer the
      // same requestId twice and dequeue twice, silently dropping the prompt
      // queued behind it.
      if (permissionInFlightRef.current) return;
      permissionInFlightRef.current = head.requestId;
      setPermissionSubmitting(true);
      try {
        if (!connection.demoMode) {
          await requireWritableClient().call("interaction/respond_permission", {
            sessionId: head.sessionId,
            requestId: head.requestId,
            response,
            // The desktop routes the answer by origin. Dropping it defaults to
            // `rust_agent`, which sends cli_hook / ACP answers to the native
            // permission manager, where they resolve nothing.
            origin: head.origin ?? "rust_agent",
          });
        }
        // Dequeue by id, never blind: the queue may have grown while the
        // answer was in flight.
        setInteractionQueue((prev) =>
          dequeuePermissionRequest(prev, head.requestId)
        );
      } finally {
        permissionInFlightRef.current = null;
        setPermissionSubmitting(false);
      }
    },
    [
      connection.demoMode,
      interactionQueue,
      requireWritableClient,
      transcript.sessionId,
    ]
  );

  /** Escape hatch for a prompt the desktop resolved without telling us. */
  const dismissPermissionHead = useCallback(() => {
    if (permissionInFlightRef.current) return;
    const head = peekPermissionRequest(interactionQueue, transcript.sessionId);
    if (!head) return;
    setInteractionQueue((prev) =>
      dequeuePermissionRequest(prev, head.requestId)
    );
  }, [interactionQueue, transcript.sessionId]);

  const stopSession = useCallback(
    async (sessionId: string) => {
      if (connection.demoMode) return;
      await requireWritableClient().call("session/cancel", { sessionId });
    },
    [connection.demoMode, requireWritableClient]
  );

  useEffect(() => {
    const handleVisible = () => {
      const config = activeConfigRef.current;
      clearReconnectTimer();
      if (platform.runtime.isHidden()) {
        if (clientRef.current || socketRef.current) {
          releaseTransport(true);
          setConnection((previous) => ({
            ...previous,
            status: "connecting",
            presence: "offline",
            error: undefined,
          }));
        }
        return;
      }
      if (config && !clientRef.current) {
        void runReconnect(config, generationRef.current);
      }
    };
    return platform.runtime.subscribeVisibility(handleVisible);
  }, [clearReconnectTimer, platform.runtime, releaseTransport, runReconnect]);

  useEffect(() => {
    if (suppressInitialBootstrap) {
      return () => {
        generationRef.current += 1;
        clearReconnectTimer();
        releaseTransport(true);
      };
    }
    let disposed = false;
    const bootstrapGeneration = generationRef.current;
    void (async () => {
      const config = relayUrl?.trim()
        ? { wsUrl: relayUrl.trim() }
        : await platform.connection.load(authUserId);
      if (disposed || bootstrapGeneration !== generationRef.current) {
        return;
      }
      setConnectionConfig(config);
      if (config?.wsUrl || config?.host) {
        await connectLive(config).catch(() => undefined);
      } else if (demoByDefault) {
        enterDemoMode();
      }
    })();
    return () => {
      disposed = true;
      generationRef.current += 1;
      clearReconnectTimer();
      releaseTransport(true);
    };
    // Mount-only bootstrap; callbacks are stable over the provider lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activePermission = peekPermissionRequest(
    interactionQueue,
    transcript.sessionId
  );
  const permissionQueueDepth = countPermissionRequests(
    interactionQueue,
    transcript.sessionId
  );
  const transcriptView = getSelectedTranscriptView(transcript);
  const value = useMemo<MobileRemoteContextValue>(
    () => ({
      connection,
      sessions,
      transcriptItems: transcriptView.items,
      transcriptPhase: transcriptView.phase,
      transcriptError: transcriptView.error,
      transcriptTruncated: transcriptView.truncated,
      transcriptRounds: transcript.rounds,
      transcriptRoundsComplete: transcript.roundsComplete,
      selectedRoundId: transcript.selectedRoundId,
      activeRoundId: transcriptView.roundId,
      sendStatus,
      activePermission,
      permissionQueueDepth,
      permissionSubmitting,
      rpc: clientRef.current,
      connectionConfig,
      connectLive,
      enterDemoMode,
      disconnect,
      refreshSessions,
      subscribeSession,
      unsubscribeSession,
      selectRound,
      retrySelectedRound,
      sendMessage,
      openSessionFileInDesktop,
      respondPermission,
      dismissPermissionHead,
      stopSession,
      sessionModel,
      refreshSessionModel,
      setSessionModel,
    }),
    [
      activePermission,
      connectLive,
      connectionConfig,
      connection,
      dismissPermissionHead,
      disconnect,
      enterDemoMode,
      permissionQueueDepth,
      permissionSubmitting,
      refreshSessionModel,
      refreshSessions,
      openSessionFileInDesktop,
      respondPermission,
      retrySelectedRound,
      selectRound,
      sendMessage,
      sendStatus,
      sessionModel,
      sessions,
      setSessionModel,
      stopSession,
      subscribeSession,
      transcript.rounds,
      transcript.roundsComplete,
      transcript.selectedRoundId,
      transcriptView.error,
      transcriptView.items,
      transcriptView.phase,
      transcriptView.roundId,
      transcriptView.truncated,
      unsubscribeSession,
    ]
  );

  return (
    <MobileRemoteContext.Provider value={value}>
      {children}
    </MobileRemoteContext.Provider>
  );
}

export function useMobileRemote(): MobileRemoteContextValue {
  const value = useContext(MobileRemoteContext);
  if (!value) {
    throw new Error(
      "useMobileRemote must be used within MobileRemoteProviders"
    );
  }
  return value;
}

MobileRemoteProviders.displayName = "MobileRemoteProviders";
