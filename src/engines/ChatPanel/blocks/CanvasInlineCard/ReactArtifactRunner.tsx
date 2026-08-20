import { invoke } from "@tauri-apps/api/core";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { isWindows } from "@src/util/platform/tauri";

import {
  REACT_ARTIFACT_FRAME_SANDBOX,
  buildReactArtifactDocument,
} from "./reactArtifactDocument";

export interface ReactArtifactError {
  message: string;
  stack?: string;
}

export interface ReactArtifactRunnerProps {
  source: string;
  onError?: (error: ReactArtifactError) => void;
}

function toReactArtifactError(error: unknown): ReactArtifactError {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic content id for an artifact source: two independent 32-bit
 * FNV-1a hashes plus the source length, hex-encoded. Matches the backend id
 * grammar (`[A-Za-z0-9_-]{8,64}`) and stays stable across renders and app
 * restarts so re-publishing the same source hits the same store slot.
 */
export function reactArtifactId(source: string): string {
  const primary = fnv1a32(source, 0x811c9dc5);
  const secondary = fnv1a32(source, 0x811c9dc5 ^ 0x5bd1e995);
  return `ra-${primary.toString(16).padStart(8, "0")}${secondary
    .toString(16)
    .padStart(8, "0")}-${source.length.toString(16)}`;
}

/**
 * Platform-aware URL for a published artifact. Tauri custom URI schemes are
 * mapped by WebView2 onto `http://<scheme>.localhost/` on Windows, while
 * WKWebView/WebKitGTK keep the raw `<scheme>://localhost/` shape.
 */
export function canvasArtifactUrl(
  id: string,
  windowsHost: boolean = isWindows()
): string {
  return windowsHost
    ? `http://canvas-artifact.localhost/${id}`
    : `canvas-artifact://localhost/${id}`;
}

// Mirror of the Rust store bound (MAX_STORED_ARTIFACTS in
// canvas_artifacts.rs). Remembering only the newest N published ids keeps
// this cache coherent with backend eviction: an id dropped here gets
// re-published on next mount, which reinserts it into the backend store.
const PUBLISHED_ID_CAPACITY = 16;

const publishedIds = new Set<string>();
const inFlightPublishes = new Map<string, Promise<void>>();

function rememberPublished(id: string): void {
  publishedIds.delete(id);
  publishedIds.add(id);
  while (publishedIds.size > PUBLISHED_ID_CAPACITY) {
    const oldest = publishedIds.values().next().value;
    if (oldest === undefined) break;
    publishedIds.delete(oldest);
  }
}

/**
 * Publishes an artifact document to the backend store exactly once per id:
 * repeated calls for an already-published or in-flight id reuse the prior
 * invoke instead of re-sending the (up to 2 MiB) document.
 */
function publishReactArtifact(id: string, html: string): Promise<void> {
  if (publishedIds.has(id)) return Promise.resolve();
  let pending = inFlightPublishes.get(id);
  if (!pending) {
    pending = invoke("canvas_artifact_publish", { id, html })
      .then(() => {
        rememberPublished(id);
      })
      .finally(() => {
        inFlightPublishes.delete(id);
      });
    inFlightPublishes.set(id, pending);
  }
  return pending;
}

/** Test seam: clears the module-level publish dedupe state. */
export function __resetReactArtifactPublisherForTests(): void {
  publishedIds.clear();
  inFlightPublishes.clear();
}

// Publish progress for one artifact id. "Publishing" is implicit: while no
// entry exists for the current id, the runner shows the loading state.
type PublishState =
  | { id: string; kind: "ready" }
  | { id: string; kind: "error"; error: ReactArtifactError };

/**
 * Visible error surface for compile and publish failures. Runtime errors
 * inside the artifact are rendered by the sandbox document's own overlay
 * (iframe-internal) and never reach this banner.
 */
const ArtifactErrorBanner: React.FC<{ error: ReactArtifactError }> = ({
  error,
}) => (
  <pre
    role="alert"
    data-testid="react-artifact-error"
    className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-danger-6/40 bg-danger-6/10 p-2 font-mono text-[11px] leading-4 text-danger-6"
  >
    {error.message}
  </pre>
);

/**
 * Executes agent-generated React source in a CSP-isolated iframe.
 *
 * The source is compiled into a self-contained sandbox document
 * (`buildReactArtifactDocument`), published to the Rust in-memory store via
 * `canvas_artifact_publish`, and rendered through an iframe whose `src`
 * points at the `canvas-artifact` custom scheme. The response carries its own
 * CSP, so the artifact executes even though the app webview forbids eval and
 * inline scripts. `sandbox="allow-scripts"` (no allow-same-origin) keeps the
 * artifact in an opaque origin with no path to Tauri IPC.
 */
const ReactArtifactRunner: React.FC<ReactArtifactRunnerProps> = ({
  source,
  onError,
}) => {
  const { t } = useTranslation("sessions");

  const compiled = useMemo(() => {
    try {
      return {
        id: reactArtifactId(source),
        html: buildReactArtifactDocument(source),
        error: null,
      };
    } catch (error) {
      return { id: null, html: null, error: toReactArtifactError(error) };
    }
  }, [source]);

  const [publish, setPublish] = useState<PublishState | null>(null);

  useEffect(() => {
    const { id, html } = compiled;
    if (id === null || html === null) return;
    let cancelled = false;
    publishReactArtifact(id, html)
      .then(() => {
        if (!cancelled) {
          setPublish((current) =>
            current?.id === id && current.kind === "ready"
              ? current
              : { id, kind: "ready" }
          );
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPublish({ id, kind: "error", error: toReactArtifactError(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [compiled]);

  // State recorded for a previous source is ignored, so a source change
  // falls back to the loading view until its own publish settles.
  const publishForCurrent = publish?.id === compiled.id ? publish : null;

  const activeError: ReactArtifactError | null =
    compiled.error ??
    (publishForCurrent?.kind === "error" ? publishForCurrent.error : null);

  const reportedErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeError) {
      reportedErrorRef.current = null;
      return;
    }
    const errorKey = `${compiled.id ?? "compile"}:${activeError.message}`;
    if (reportedErrorRef.current === errorKey) return;
    reportedErrorRef.current = errorKey;
    onError?.(activeError);
  }, [activeError, compiled.id, onError]);

  if (activeError) {
    return (
      <div className="h-full min-h-0 w-full overflow-auto bg-bg-1 p-4">
        <ArtifactErrorBanner error={activeError} />
      </div>
    );
  }

  const ready = publishForCurrent?.kind === "ready";

  return (
    <div className="h-full min-h-0 w-full bg-bg-1">
      {ready && compiled.id !== null ? (
        <iframe
          title={t("canvasApp.reactArtifactFrame", "React canvas preview")}
          data-testid="react-artifact-frame"
          src={canvasArtifactUrl(compiled.id)}
          sandbox={REACT_ARTIFACT_FRAME_SANDBOX}
          className="h-full w-full border-0"
        />
      ) : (
        <div
          data-testid="react-artifact-loading"
          aria-busy="true"
          className="h-full w-full"
        />
      )}
    </div>
  );
};

export default ReactArtifactRunner;
