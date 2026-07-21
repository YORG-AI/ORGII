export type InteractionType =
  | "auto"
  | "click"
  | "hover"
  | "keyboard"
  | "focus"
  | "unknown";

/** How a request crosses the frontend boundary. This is deliberately not a
 * backend identity: ORGII has one Rust backend, exposed through both HTTP and
 * Tauri IPC. */
export type ApiTransport = "http" | "tauri";

export interface ApiCall {
  id: string;
  method: string;
  url: string;
  fullUrl: string;
  transport: ApiTransport;
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
  data?: unknown;
  status?: number;
  statusText?: string;
  response?: unknown;
  error?: unknown;
  duration?: number;
  timestamp: string;
  componentSelector?: string;
  componentLabel?: string;
  interactionType?: InteractionType;
  filePath?: string;
  componentName?: string;
  functionName?: string;
  lineNumber?: number;
  stack?: string;
  tauriCommand?: string;
  tauriArgs?: unknown;
}

export type TimerKind = "interval" | "timeout" | "raf";

export interface TimerFireEvent {
  id: string;
  kind: TimerKind;
  delayMs?: number;
  timestamp: string;
  filePath?: string;
  componentName?: string;
  functionName?: string;
  lineNumber?: number;
  stack?: string;
}

export interface TimerHotspot {
  key: string;
  kind: TimerKind;
  delayMs?: number;
  count: number;
  firesPerMinute: number;
  lastTimestamp: string;
  firstTimestamp: string;
  componentName?: string;
  functionName?: string;
  filePath?: string;
  lineNumber?: number;
  stack?: string;
  isLikelyLoop: boolean;
}

export type PushKind = "tauri-event" | "channel" | "ws" | "sse";

export interface PushHotspot {
  key: string;
  kind: PushKind;
  name: string;
  count: number;
  eventsPerMinute: number;
  lastTimestamp: string;
  firstTimestamp: string;
  isLikelyStream: boolean;
}

export interface ApiCallHotspot {
  key: string;
  transport: ApiTransport;
  method: string;
  target: string;
  count: number;
  callsPerMinute: number;
  averageDurationMs?: number;
  lastTimestamp: string;
  firstTimestamp: string;
  interactionType?: InteractionType;
  componentName?: string;
  functionName?: string;
  filePath?: string;
  lineNumber?: number;
  stack?: string;
  isLikelyPolling: boolean;
}
