/**
 * A2UIRenderer — React renderer for A2UI mode using the official @a2ui/react v0.9 API.
 *
 * Architecture:
 *   1. A `MessageProcessor` (from @a2ui/web_core/v0_9) is created once per mount,
 *      holding a custom `Catalog` that wraps our own `a2uiElements.tsx` renderers.
 *   2. Incoming `lines[]` props are translated into v0.9 wire-protocol messages
 *      (`createSurface` + `updateComponents`) and fed to `processor.processMessages()`.
 *   3. `A2uiSurface` (from @a2ui/react/v0_9) drives React rendering via Preact signals,
 *      re-rendering only the components that actually changed.
 *   4. Each element component uses `createBinderlessComponentImplementation` so it reads
 *      props straight from `context.componentModel.properties` without going through the
 *      `GenericBinder` expression system — our JSONL props are always static literals.
 *
 * Preserved from the previous implementation:
 *   - `evalScript()` ref API (canvas_eval equivalent)
 *   - `A2UIActionProvider` wrapping for button/form action callbacks
 *   - All 11 element type renderers from `a2uiElements.tsx`
 *   - DOMPurify sanitization for `type="html"` elements
 *   - recharts integration for `type="chart"` elements
 */
import {
  A2uiSurface,
  createBinderlessComponentImplementation,
} from "@a2ui/react/v0_9";
import { Catalog, MessageProcessor } from "@a2ui/web_core/v0_9";
import type { ComponentApi } from "@a2ui/web_core/v0_9";
import type { SurfaceModel } from "@a2ui/web_core/v0_9";
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import { createLogger } from "@src/hooks/logger";

import { A2UIActionProvider } from "./A2UIActionContext";
import type { A2UIActionHandler } from "./A2UIActionContext";
import { renderA2UIElement } from "./a2uiElements";
import type { A2UIElement } from "./types";

const log = createLogger("A2UIRenderer");

// ─── catalog definition ────────────────────────────────────────────────────────

/**
 * Catalog ID we advertise. The `createSurface` message must reference this ID
 * for `MessageProcessor` to route messages to our catalog.
 */
const CUSTOM_CATALOG_ID = "https://orgii.internal/a2ui-catalog/v1";

/**
 * The surface ID we use. Constant since each renderer instance owns one surface.
 */
const SURFACE_ID = "main";

/**
 * Minimal ComponentApi for our custom elements.
 * `createBinderlessComponentImplementation` is binderless — it doesn't use the
 * schema for prop binding (only `GenericBinder` does). We pass a stub schema to
 * satisfy the type signature.
 *
 * The project uses zod v4 while @a2ui/web_core expects zod v3 — they are
 * structurally incompatible at the TypeScript level, so we cast via `any`.
 */
function makeApi(name: string): ComponentApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { name, schema: { _def: {} } as any };
}

/**
 * The root container component — renders all child elements by calling
 * `buildChild(id)` for each ID in `properties.children`.
 */
const rootImpl = createBinderlessComponentImplementation(
  makeApi("a2ui-root"),
  ({ context, buildChild }) => {
    const children: string[] = context.componentModel.properties.children ?? [];
    return (
      <div className="contents">
        {children.map((id) => (
          <React.Fragment key={id}>{buildChild(id)}</React.Fragment>
        ))}
      </div>
    );
  }
);

/**
 * Factory: create a `ReactComponentImplementation` that reads the full raw
 * properties object from the component model and delegates to our existing
 * `renderA2UIElement()` renderer.
 *
 * The `type` field must match what we inject into `updateComponents` messages.
 */
function makeElementImpl(type: string) {
  return createBinderlessComponentImplementation(
    makeApi(type),
    ({ context }) => {
      const props = context.componentModel.properties as A2UIElement;
      return <>{renderA2UIElement(props, 0)}</>;
    }
  );
}

const ELEMENT_TYPES = [
  "heading",
  "text",
  "code",
  "image",
  "button",
  "divider",
  "list",
  "html",
  "table",
  "chart",
  "form",
] as const;

/**
 * Our custom catalog, registered under CUSTOM_CATALOG_ID.
 * Contains the root container plus all 11 element type renderers.
 *
 * Cast via `any` to bridge the zod v3/v4 structural mismatch between
 * our project and @a2ui/web_core's internal types.
 */
const customCatalog = new Catalog(
  CUSTOM_CATALOG_ID,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [rootImpl, ...ELEMENT_TYPES.map(makeElementImpl)] as any
);

// ─── JSONL → v0.9 message translation ─────────────────────────────────────────

/**
 * Translate our custom JSONL element array into a pair of v0.9 wire messages:
 *
 * 1. `createSurface` — creates the surface using our custom catalog ID.
 * 2. `updateComponents` — declares a root "column" plus one component per element.
 *
 * The root component holds a `children` list of all element IDs. Each element
 * component carries its full original JSONL properties, which the binderless
 * renderers read directly from `context.componentModel.properties`.
 */
function buildMessages(elements: A2UIElement[]) {
  const childIds = elements.map((_, i) => `el-${i}`);

  const componentRecords = [
    {
      component: "a2ui-root",
      id: "root",
      children: childIds,
    },
    ...elements.map((el, i) => ({
      ...el,
      component: el.type,
      id: `el-${i}`,
    })),
  ];

  return [
    {
      version: "v0.9" as const,
      createSurface: {
        surfaceId: SURFACE_ID,
        catalogId: CUSTOM_CATALOG_ID,
      },
    },
    {
      version: "v0.9" as const,
      updateComponents: {
        surfaceId: SURFACE_ID,
        components: componentRecords,
      },
    },
  ];
}

// ─── surface reactivity hook ───────────────────────────────────────────────────

type AnyMessageProcessor = MessageProcessor<ComponentApi>;

/**
 * Subscribe to surface changes so React re-renders when the processor
 * produces a new surface (or updates components on an existing one).
 *
 * Uses `useSyncExternalStore` so the subscription is React-concurrent safe.
 */
function useSurface(
  processor: AnyMessageProcessor
): SurfaceModel<ComponentApi> | undefined {
  const storeRef = useRef<{
    subscribe: (cb: () => void) => () => void;
    getSnapshot: () => SurfaceModel<ComponentApi> | undefined;
  } | null>(null);

  if (!storeRef.current) {
    let version = 0;
    const listeners = new Set<() => void>();
    const notify = () => {
      version++;
      listeners.forEach((l) => l());
    };

    processor.onSurfaceCreated((surface: SurfaceModel<ComponentApi>) => {
      surface.componentsModel.onCreated.subscribe(() => notify());
      surface.componentsModel.onDeleted.subscribe(() => notify());
      notify();
    });
    processor.onSurfaceDeleted(() => notify());

    storeRef.current = {
      subscribe: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      getSnapshot: () => {
        void version;
        return processor.model.getSurface(SURFACE_ID);
      },
    };
  }

  return useSyncExternalStore(
    storeRef.current.subscribe,
    storeRef.current.getSnapshot
  );
}

// ─── public API ────────────────────────────────────────────────────────────────

export interface A2UIRendererHandle {
  /** Execute a JS string in a sandboxed try/catch — canvas_eval equivalent. */
  evalScript(js: string): void;
}

export interface A2UIRendererProps {
  /** Raw JSONL content string from the agent. */
  lines: string[];
  /** Called when a button is clicked or form is submitted. */
  onAction?: A2UIActionHandler;
  /** Session ID forwarded to A2UIActionProvider for event tagging. */
  sessionId?: string;
  className?: string;
  /**
   * When true and content is already visible, a subtle pulsing dot indicates
   * that more streamed elements are expected.
   */
  isStreaming?: boolean;
}

// ─── component ─────────────────────────────────────────────────────────────────

const A2UIRenderer = forwardRef<A2UIRendererHandle, A2UIRendererProps>(
  ({ lines, onAction, sessionId, className, isStreaming = false }, ref) => {
    useImperativeHandle(ref, () => ({
      evalScript(js: string) {
        try {
          // Sandboxed eval: no iframe boundary, but wrapped in try/catch.
          new Function(js)();
        } catch (err) {
          log.error("[canvas_eval]", err);
        }
      },
    }));

    /**
     * `MessageProcessor` is created once per component mount. It owns the
     * catalog and surface state — recreating it would wipe all surfaces.
     * Action handling is wired through `A2UIActionContext` rather than the
     * processor's `actionHandler` so our existing `onAction` / session-event
     * dispatch path stays intact.
     *
     * Cast to `AnyMessageProcessor` so useSurface can accept it — the catalog's
     * concrete ReactComponentImplementation type is compatible with ComponentApi.
     */
    const processor = useMemo<AnyMessageProcessor>(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mp = new MessageProcessor([customCatalog as any]);
      return mp as unknown as AnyMessageProcessor;
    }, []);

    /**
     * Parse JSONL lines into our element array, then translate to v0.9
     * messages and feed them to the processor. We push `createSurface` every
     * time lines change but the processor silently ignores duplicate surface
     * IDs, so this is safe.
     */
    const elements = useMemo<A2UIElement[]>(() => {
      return lines.map((line) => {
        try {
          return JSON.parse(line) as A2UIElement;
        } catch {
          return { type: "text", content: line } as A2UIElement;
        }
      });
    }, [lines]);

    useEffect(() => {
      if (elements.length === 0) return;
      const messages = buildMessages(elements);
      // MessageProcessor.processMessages accepts A2uiMessage[] — our
      // translated messages conform to that shape exactly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      processor.processMessages(messages as any);
    }, [processor, elements]);

    const surface = useSurface(processor);

    return (
      <A2UIActionProvider onAction={onAction} sessionId={sessionId}>
        <div
          className={[
            "a2ui-renderer relative overflow-y-auto p-4 text-sm text-text-2",
            className,
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {surface ? (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            <A2uiSurface surface={surface as any} />
          ) : null}

          {/* Streaming indicator — pulsing dot in bottom-right corner */}
          {isStreaming && (
            <div className="sticky bottom-2 flex justify-end pr-1" aria-hidden>
              <span className="inline-flex items-center gap-1 rounded-full bg-fill-3/80 px-2 py-0.5 text-[10px] text-text-4 backdrop-blur-xs">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary-6" />
                streaming
              </span>
            </div>
          )}
        </div>
      </A2UIActionProvider>
    );
  }
);

A2UIRenderer.displayName = "A2UIRenderer";
export default A2UIRenderer;
