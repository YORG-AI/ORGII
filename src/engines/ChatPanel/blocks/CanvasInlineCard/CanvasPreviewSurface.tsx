import DOMPurify from "dompurify";
import { ExternalLink, Layout } from "lucide-react";
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";

import type { A2UIActionHandler } from "./A2UIActionContext";
import A2UIRenderer, { type A2UIRendererHandle } from "./A2UIRenderer";
import ReactArtifactRunner, {
  type ReactArtifactError,
} from "./ReactArtifactRunner";
import {
  type CanvasPreviewPayload,
  type CanvasPreviewSurfaceVariant,
  getCanvasPreviewRenderKind,
  splitA2UIContent,
} from "./canvasPreviewPolicy";
import {
  buildStaticHtmlShadowMarkup,
  extractStaticHtmlBody,
  extractStaticHtmlStyles,
} from "./staticHtmlCanvas";

export interface CanvasPreviewSurfaceHandle {
  evalScript: (javascript: string) => void;
}

const StaticHtmlCanvas: React.FC<{ content: string }> = ({ content }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const safeContent = useMemo(() => {
    return DOMPurify.sanitize(extractStaticHtmlBody(content), {
      FORBID_TAGS: [
        "script",
        "iframe",
        "object",
        "embed",
        "link",
        "meta",
        "base",
        "style",
      ],
      // Inline CSS is not sanitized by DOMPurify. Presentation belongs in the
      // separately filtered <style> blocks so it cannot override containment.
      FORBID_ATTR: ["srcdoc", "style"],
    });
  }, [content]);
  const styles = useMemo(() => extractStaticHtmlStyles(content), [content]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = buildStaticHtmlShadowMarkup(safeContent, styles);
  }, [safeContent, styles]);

  return (
    <div ref={hostRef} className="h-full min-w-0 max-w-full overflow-hidden" />
  );
};

const NonEmbeddedUrlNotice: React.FC<{ url: string }> = ({ url }) => {
  const { t } = useTranslation("sessions");
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Layout size={24} strokeWidth={1.5} className="text-text-4" />
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
          icon={<ExternalLink size={14} />}
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
          <A2UIRenderer
            ref={rendererRef}
            lines={a2uiLines}
            isStreaming={payload?.streaming}
            onAction={onAction}
            sessionId={sessionId}
            className={a2uiClassName}
          />
        );
    } else if (renderKind === "html" && payloadContent) {
      content = <StaticHtmlCanvas content={payloadContent} />;
    } else if (renderKind === "react" && payloadContent) {
      content = (
        <ReactArtifactRunner
          key={reloadKey === undefined ? undefined : `react-${reloadKey}`}
          source={payloadContent}
          onError={handleReactArtifactError}
        />
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
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-red-100/80">
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
