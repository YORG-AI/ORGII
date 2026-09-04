/**
 * Unified Event Renderer Hook
 *
 * Renders events for the Simulator. The chat panel has its own entry point
 * ({@link ActivityRouter} → `getChatLazyComponent`) and trajectory rendering
 * uses the normalizer's `variant` field directly — neither flows through
 * this hook. See `UnifiedRenderContext` in `registry/types.ts` for the
 * rationale behind the single-value context union.
 *
 * Features:
 * - Shared component cache (via `getEventComponentSync` / `loadEventComponent`)
 * - Consistent event normalization
 * - Error boundaries and Suspense
 * - Memoized render function
 */
import React, { Suspense, useCallback } from "react";

import InlineAlert from "@src/components/InlineAlert";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { getCliUiCanonical } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import type {
  RenderMode,
  UnifiedRenderOptions,
} from "@src/engines/SessionCore/rendering/registry/types";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";
import { getRegistryEventType } from "@src/lib/activityData/activityNormalizers";

import {
  COMPONENT_LOADERS,
  CONTEXT_CONFIG,
  getEventComponentSync,
  loadEventComponent,
  resolveEventType,
} from "./registry/events";

const log = createLogger("UnifiedEventRenderer");

// ============================================
// Types
// ============================================

/** Event data type — can be a full SessionEvent or a raw event record */
export type EventData = SessionEvent | Record<string, unknown>;

/** Extra props that can be passed to components */
export interface ExtraProps extends Record<string, unknown> {
  /** Rendering mode */
  mode?: RenderMode;
  /** Animation config */
  enableTypewriter?: boolean;
  typewriterConfig?: unknown;
  enableAutoScroll?: boolean;
  autoScrollConfig?: unknown;
  autoScrollLoop?: boolean;
}

/** Return type for the hook */
export interface UseUnifiedEventRendererReturn {
  /** Render a single event */
  renderEvent: (event: EventData, extras?: ExtraProps) => React.ReactNode;
}

// ============================================
// Loading Fallback
// ============================================

const LoadingFallback: React.FC = () => (
  <div className="flex items-center justify-center p-4 text-text-3">
    <span className="text-[13px]">{i18n.t("placeholders.loading")}</span>
  </div>
);

// ============================================
// Error Boundary
// ============================================

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ErrorBoundaryProps {
  children?: React.ReactNode;
  eventType: string;
  fallback?: React.ReactNode;
}

class UnifiedErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    log.error(
      `[UnifiedEventRenderer] Failed to render ${this.props.eventType}:`,
      error,
      errorInfo
    );
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <InlineAlert
          type="danger"
          title={i18n.t("common:status.error")}
          hideIcon
        >
          <span className="text-[13px]">
            {i18n.t("errors.failedToRenderEvent")}
          </span>
          <code className="mt-1 block text-[11px] text-text-3">
            {this.props.eventType}
          </code>
        </InlineAlert>
      );
    }

    return this.props.children;
  }
}

// ============================================
// Lazy Component Wrapper
// ============================================

interface LazyEventComponentProps {
  eventType: string;
  event: EventData;
  mode: RenderMode;
  extras?: ExtraProps;
}

const LazyEventComponent: React.FC<LazyEventComponentProps> = ({
  eventType,
  event,
  mode,
  extras = {},
}) => {
  const [Component, setComponent] = React.useState<React.ComponentType<
    Record<string, unknown>
  > | null>(() => getEventComponentSync(eventType));
  const [loading, setLoading] = React.useState(
    () => !getEventComponentSync(eventType)
  );

  React.useEffect(() => {
    const cached = getEventComponentSync(eventType);
    if (cached) {
      setComponent(() => cached);
      setLoading(false);
      return;
    }

    let mounted = true;
    setLoading(true);

    loadEventComponent(eventType)
      .then((comp) => {
        if (mounted) {
          setComponent(() => comp);
          setLoading(false);
        }
      })
      .catch((error) => {
        log.error(`Failed to load ${eventType}:`, error);
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [eventType]);

  if (loading) {
    return <LoadingFallback />;
  }

  if (!Component) {
    return null;
  }

  // When event is a full SessionEvent (identified by the `sessionId` field),
  // wrap it as `{ event }` so propsNormalizer's fast path fires directly.
  // Spreading flat props would bypass the fast path and trigger the
  // normalizeActivity() slow path on every render.
  const componentProps: Record<string, unknown> =
    "sessionId" in event
      ? { event: event as SessionEvent, mode, ...extras }
      : { ...(event as Record<string, unknown>), mode, ...extras };

  return <Component {...componentProps} />;
};

// ============================================
// Event Type Resolution
// ============================================

/**
 * Extract event type from event data. Handles the multiple data formats
 * produced by different pipelines (BackendEvent.function, SessionEvent
 * action/function fields, nested activityData).
 *
 * IMPORTANT: Uses getRegistryEventType which correctly handles:
 * - Tool events (action_type = "tool_call"): uses function name (e.g., "read_file")
 * - Conversation events: uses action_type first (e.g., "thinking", "assistant")
 */
function extractEventType(event: EventData): string {
  return getRegistryEventType(event);
}

// ============================================
// Stable Key Generation
// ============================================

const _eventKeyCache = new WeakMap<object, string>();
let _eventKeyCounter = 0;

/**
 * Return a stable React key for an event. Prefers `id` or `chunk_id`;
 * when neither exists, generates a deterministic fallback key per object
 * identity (WeakMap) so that re-renders don't remount the subtree.
 */
function getStableEventKey(event: EventData, eventType: string): string {
  if ("id" in event && typeof event.id === "string") return event.id;
  if ("chunk_id" in event && typeof event.chunk_id === "string")
    return event.chunk_id;

  let key = _eventKeyCache.get(event as object);
  if (!key) {
    key = `${eventType}-fb-${_eventKeyCounter++}`;
    _eventKeyCache.set(event as object, key);
  }
  return key;
}

// ============================================
// Main Hook
// ============================================

export function useUnifiedEventRenderer(
  options: UnifiedRenderOptions
): UseUnifiedEventRendererReturn {
  const { mode = "interactive" } = options;

  const renderEvent = useCallback(
    (event: EventData, extras: ExtraProps = {}): React.ReactNode => {
      if (!event) {
        if (process.env.NODE_ENV === "development") {
          log.warn(
            "[UnifiedEventRenderer] renderEvent called with undefined event"
          );
        }
        return null;
      }

      const rawEventType = extractEventType(event);
      let eventType = resolveEventType(rawEventType);
      let uiCanonical = getCliUiCanonical(eventType);

      // Fallback: if function name isn't registered but action_type is
      // "tool_call", use the generic "tool_call" renderer. Handles OS Agent
      // tools like "exec"/"file_read" that don't have dedicated renderers.
      if (!COMPONENT_LOADERS[uiCanonical]) {
        const actionType =
          "action_type" in event
            ? (event as Record<string, unknown>).action_type
            : undefined;
        if (actionType === "tool_call") {
          eventType = "tool_call";
          uiCanonical = "tool_call";
        }
      }

      if (!COMPONENT_LOADERS[uiCanonical]) {
        return null;
      }

      // The unified hook only serves the simulator, which requires a per-tool
      // simulator context config. Tools without one (chat-only) bail out here.
      const contextConfig = CONTEXT_CONFIG[uiCanonical]?.simulator;
      if (!contextConfig) {
        return null;
      }

      const eventId = getStableEventKey(event, eventType);

      return (
        <UnifiedErrorBoundary key={eventId} eventType={eventType}>
          <Suspense fallback={<LoadingFallback />}>
            <LazyEventComponent
              eventType={eventType}
              event={event}
              mode={mode}
              extras={extras}
            />
          </Suspense>
        </UnifiedErrorBoundary>
      );
    },
    [mode]
  );

  return { renderEvent };
}

export default useUnifiedEventRenderer;
