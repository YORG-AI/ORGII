/**
 * WebSocket Provider
 *
 * React context provider for global WebSocket client management.
 * Initialize once per session, access anywhere via useWSClient hook.
 *
 * Protocol:
 *   1. Connect: ws://server/api/ws?session_id=xxx
 *   2. Receive events for that session (auto-subscribed)
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  OrgiiaiWSClient,
  OrgiiaiWSClientOptions,
  destroyWSClient,
  initWSClient,
} from "./client";

export interface WSContextValue {
  client: OrgiiaiWSClient | null;
  connected: boolean;
  sessionId: string | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

export interface WSProviderProps {
  serverUrl: string;
  sessionId: string;
  options?: OrgiiaiWSClientOptions;
  autoConnect?: boolean;
  children: React.ReactNode;
}

const WSContext = createContext<WSContextValue | null>(null);

export const WSProvider: React.FC<WSProviderProps> = ({
  serverUrl,
  sessionId,
  options,
  autoConnect = true,
  children,
}) => {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Use state for client so context value updates when client is created
  const [client, setClient] = useState<OrgiiaiWSClient | null>(null);
  const {
    pingInterval,
    maxReconnectAttempts,
    initialReconnectDelay,
    maxReconnectDelay,
    debug,
    startFrom,
    onBeforeReconnect,
  } = options ?? {};

  // Track which (serverUrl, sessionId) pair we've initialized.
  // IMPORTANT: must allow re-initialization when switching sessions.
  const initializedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!serverUrl || !sessionId) {
      return;
    }

    const key = `${serverUrl}::${sessionId}`;
    if (initializedKeyRef.current === key) {
      return;
    }
    initializedKeyRef.current = key;

    const clientOptions: OrgiiaiWSClientOptions = {
      debug: debug ?? process.env.NODE_ENV === "development",
    };
    if (pingInterval !== undefined) clientOptions.pingInterval = pingInterval;
    if (maxReconnectAttempts !== undefined) {
      clientOptions.maxReconnectAttempts = maxReconnectAttempts;
    }
    if (initialReconnectDelay !== undefined) {
      clientOptions.initialReconnectDelay = initialReconnectDelay;
    }
    if (maxReconnectDelay !== undefined) {
      clientOptions.maxReconnectDelay = maxReconnectDelay;
    }
    if (startFrom !== undefined) clientOptions.startFrom = startFrom;
    if (onBeforeReconnect !== undefined) {
      clientOptions.onBeforeReconnect = onBeforeReconnect;
    }
    const wsClient = initWSClient(serverUrl, sessionId, clientOptions);
    // Update state so context value re-computes with the client
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the externally-owned WebSocket instance only exists after this lifecycle effect creates it; context consumers must receive that exact disposable instance
    setClient(wsClient);

    const unsubConnected = wsClient.on("connected", () => {
      setConnected(true);
      setError(null);
    });

    const unsubDisconnected = wsClient.on("disconnected", () => {
      setConnected(false);
    });

    const unsubError = wsClient.on("error", (data) => {
      const msg = data as { message: string };
      setError(msg.message);
    });

    if (autoConnect) {
      wsClient.connect().catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }

    return () => {
      unsubConnected();
      unsubDisconnected();
      unsubError();
      destroyWSClient();
      setClient(null);
      initializedKeyRef.current = null;
      setConnected(false);
      setError(null);
    };
  }, [
    serverUrl,
    sessionId,
    autoConnect,
    pingInterval,
    maxReconnectAttempts,
    initialReconnectDelay,
    maxReconnectDelay,
    debug,
    startFrom,
    onBeforeReconnect,
  ]);

  const connect = useCallback(async () => {
    if (client) {
      await client.connect();
    }
  }, [client]);

  const disconnect = useCallback(() => {
    if (client) {
      client.disconnect();
    }
  }, [client]);

  const value = useMemo<WSContextValue>(
    () => ({
      client,
      connected,
      sessionId,
      error,
      connect,
      disconnect,
    }),
    [client, connected, sessionId, error, connect, disconnect]
  );

  return <WSContext.Provider value={value}>{children}</WSContext.Provider>;
};

export function useWSClient(): WSContextValue {
  const context = useContext(WSContext);
  if (!context) {
    throw new Error("useWSClient must be used within a WSProvider");
  }
  return context;
}

export function useWSAvailable(): boolean {
  const context = useContext(WSContext);
  return context !== null;
}

export function useWSClientSafe(): WSContextValue | null {
  return useContext(WSContext);
}

export default WSProvider;
