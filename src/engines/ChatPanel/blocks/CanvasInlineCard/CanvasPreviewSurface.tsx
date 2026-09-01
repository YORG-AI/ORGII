import React, {
  Suspense,
  forwardRef,
  lazy,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  HugeiconsIcon,
  Layout01Icon,
  SquareArrowUpRight02Icon,
} from "@src/icons";

import type { A2UIActionHandler } from "./A2UIActionContext";
import type { A2UIRendererHandle } from "./A2UIRenderer";
import type { ReactArtifactError } from "./ReactArtifactRunner";
import {
  type CanvasPreviewPayload,
  type CanvasPreviewSurfaceVariant,
  getCanvasPreviewRenderKind,
  splitA2UIContent,
} from "./canvasPreviewPolicy";
import {
  buildStaticHtmlShadowMarkup,
  extractStaticHtmlStyles,
  sanitizeStaticHtmlBody,
} from "./staticHtmlCanvas";

// Lazy render kinds. CanvasInlineCard is reached from the agent-message
// renderer (every chat), but A2UI (recharts + @a2ui) and React artifacts
// (sucrase + the embedded React 18 runtime text) are only needed when a
// canvas of that kind is actually shown.
const A2UIRenderer = lazy(() => import("./A2UIRenderer"));
const ReactArtifactRunner = lazy(() => import("./ReactArtifactRunner"));

export interface CanvasPreviewSurfaceHandle {
  evalScript: (javascript: string) => void;
}

const StaticHtmlCanvas: React.FC<{ content: string }> = ({ content }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const safeContent = useMemo(() => sanitizeStaticHtmlBody(content), [content]);
  const styles = useMemo(() => extractStaticHtmlStyles(content), [content]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = buildStaticHtmlShadowMarkup(safeContent, styles);
  }, [safeContent, styles]);

  return (
    <div ref={hostRef} className="h-full max-w-full min-w-0 overflow-hidden" />
  );
};

const NonEmbeddedUrlNotice: React.FC<{ url: string }> = ({ url }) => {
  const { t } = useTranslation("sessions");
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <HugeiconsIcon
          icon={Layout01Icon}
          data-icon="panels-top-left"
          size={24}
          strokeWidth={1.5}
          className="text-text-4"
        />
        <div className="space-y-1">
          <div className="text-sm font-medium text-text-2">
            {t("canvasCard.openUrlTitle", "Preview not embedded")}
          </div>
          <div className="text-xs leading-5 text-text-4">
            {t(
              "canvasCard.openUrlDescription",
              "External URLs are not embedded to avoid iframe memory overhead."
            )}
          </div>
        </div>
        <Button
          variant="secondary"
          size="small"
          onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
          icon={
            <HugeiconsIcon
              icon={SquareArrowUpRight02Icon}
              data-icon="square-arrow-out-up-right"
              size={14}
            />
          }
        >
          {t("canvasCard.openExternal", "Open in Browser")}
        </Button>
      </div>
    </div>
  );
};

export interface CanvasPreviewSurfaceProps {
  payload: CanvasPreviewPayload | null | undefined;
  variant?: CanvasPreviewSurfaceVariant;
  title?: string;
  className?: string;
  a2uiClassName?: string;
  emptyFallback?: React.ReactNode;
  loadingFallback?: React.ReactNode;
  reloadKey?: number;
  sessionId?: string;
  onAction?: A2UIActionHandler;
}

const CanvasPreviewSurface = forwardRef<
  CanvasPreviewSurfaceHandle,
  CanvasPreviewSurfaceProps
>(
  (
    {
      payload,
      className = "relative h-full w-full overflow-hidden",
      a2uiClassName = "h-full",
      emptyFallback = null,
      loadingFallback = emptyFallback,
      reloadKey,
      sessionId,
      onAction,
    },
    ref
  ) => {
    const rendererRef = useRef<A2UIRendererHandle>(null);
    const renderKind = getCanvasPreviewRenderKind(payload);
    const payloadContent = payload?.content;
    const errorKey =
      renderKind === "react"
        ? `${payloadContent ?? ""}:${reloadKey ?? ""}`
        : "";
    const [reactArtifactError, setReactArtifactError] = useState<{
      key: string;
      message: string;
      stack?: string;
    } | null>(null);

    const handleReactArtifactError = useCallback(
      (error: ReactArtifactError) => {
        setReactArtifactError({
          key: errorKey,
          message: error.message,
          stack: error.stack,
        });
      },
      [errorKey]
    );

    useImperativeHandle(
      ref,
      () => ({
        evalScript: (javascript: string) => {
          rendererRef.current?.evalScript(javascript);
        },
      }),
      []
    );

    const a2uiLines = useMemo(() => {
      if (renderKind !== "a2ui" || !payloadContent) return [];
      return splitA2UIContent(payloadContent);
    }, [renderKind, payloadContent]);

    let content: React.ReactNode;

    if (renderKind === "url" && payload?.url) {
      content = <NonEmbeddedUrlNotice url={payload.url} />;
    } else if (renderKind === "a2ui") {
      content =
        a2uiLines.length === 0 ? (
          <>{payload?.streaming ? loadingFallback : emptyFallback}</>
        ) : (
          <Suspense fallback={loadingFallback}>
            <A2UIRenderer
              ref={rendererRef}
              lines={a2uiLines}
              isStreaming={payload?.streaming}
              onAction={onAction}
              sessionId={sessionId}
              className={a2uiClassName}
            />
          </Suspense>
        );
    } else if (renderKind === "html" && payloadContent) {
      content = <StaticHtmlCanvas content={payloadContent} />;
    } else if (renderKind === "react" && payloadContent) {
      content = (
        <Suspense fallback={loadingFallback}>
          <ReactArtifactRunner
            key={reloadKey === undefined ? undefined : `react-${reloadKey}`}
            source={payloadContent}
            onError={handleReactArtifactError}
          />
        </Suspense>
      );
    } else {
      content = emptyFallback;
    }

    return (
      <div className={className}>
        {content}
        {reactArtifactError?.key === errorKey && (
          <div className="absolute inset-x-3 bottom-3 rounded-md border border-red-500/40 bg-red-500/15 p-2 text-xs text-red-100 shadow-lg backdrop-blur">
            <div className="font-medium">{reactArtifactError.message}</div>
            {reactArtifactError.stack && (
              <pre className="mt-1 max-h-24 overflow-auto font-mono text-[10px] leading-4 whitespace-pre-wrap text-red-100/80">
                {reactArtifactError.stack}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }
);

CanvasPreviewSurface.displayName = "CanvasPreviewSurface";

export default CanvasPreviewSurface;
