/**
 * useStreamedFileSource
 *
 * Resolves a `src` for a local file preview. Preferred path: an asset-protocol
 * URL that WebKit streams from disk with range requests, so no bytes are held
 * in the webview. Fallback path (protocol unavailable, probe failed, or the
 * element reported a load error): read the file and serve a Blob object URL,
 * which is what the previews did before.
 */
import { readFile, stat } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useState } from "react";

import {
  probePreviewAssetUrl,
  resolvePreviewAssetUrl,
} from "@src/util/file/previewAssetUrl";

export interface StreamedFileSourceOptions {
  /** Absolute path of the file to show; `null` renders nothing. */
  filePath: string | null;
  /** MIME type used for the Blob fallback. */
  mimeType: string;
  /**
   * Verify the asset URL responds before using it. Required for elements
   * that cannot report a failed load (an `<iframe>`); `<video>` reports
   * errors itself and should use `onSourceError` instead.
   */
  probe?: boolean;
}

export interface StreamedFileSource {
  src: string | null;
  fileSize: number | null;
  loading: boolean;
  error: string | null;
  /** Report that the element could not load `src`; retries with a Blob. */
  onSourceError: () => void;
}

export function useStreamedFileSource({
  filePath,
  mimeType,
  probe = false,
}: StreamedFileSourceOptions): StreamedFileSource {
  const [src, setSrc] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(filePath !== null);
  const [error, setError] = useState<string | null>(null);
  // Path for which the streamed source failed; forces the Blob path for it.
  const [blobOnlyPath, setBlobOnlyPath] = useState<string | null>(null);

  const onSourceError = useCallback(() => {
    if (filePath !== null && src !== null && !src.startsWith("blob:")) {
      setBlobOnlyPath(filePath);
    }
  }, [filePath, src]);

  useEffect(() => {
    if (filePath === null) {
      setSrc(null);
      setFileSize(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    const useBlob = blobOnlyPath === filePath;

    async function load(path: string) {
      setLoading(true);
      setError(null);
      setSrc(null);
      setFileSize(null);

      try {
        if (!useBlob) {
          const assetUrl = await resolvePreviewAssetUrl(path);
          if (cancelled) return;
          if (assetUrl && (!probe || (await probePreviewAssetUrl(assetUrl)))) {
            if (cancelled) return;
            setSrc(assetUrl);
            void stat(path)
              .then((info) => {
                if (!cancelled) setFileSize(info.size);
              })
              .catch(() => {
                // Size is informational; the stream works without it.
              });
            return;
          }
          if (cancelled) return;
        }

        const data = await readFile(path);
        if (cancelled) return;
        setFileSize(data.byteLength);
        objectUrl = URL.createObjectURL(new Blob([data], { type: mimeType }));
        setSrc(objectUrl);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load file");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(filePath);

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, mimeType, probe, blobOnlyPath]);

  return { src, fileSize, loading, error, onSourceError };
}
