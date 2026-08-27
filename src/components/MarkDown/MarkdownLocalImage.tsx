/**
 * MarkdownLocalImage
 *
 * `img` renderer for chat markdown. Local image paths are read through the
 * fs plugin into a data URL (the webview origin cannot load raw filesystem
 * paths); non-image local paths (agents use `![]()` for videos too) render
 * as a file chip that opens in the WorkStation instead of being read into
 * memory; missing files degrade to a labeled placeholder. Every state
 * swallows the click so a wrapping markdown link can never navigate the
 * webview or reach the browser app with a filesystem path.
 */
import { homeDir, join } from "@tauri-apps/api/path";
import { readFile, stat } from "@tauri-apps/plugin-fs";
import { ImageIcon, ImageOff } from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";

import FileTypeIcon from "@src/components/FileTypeIcon";
import ImagePreviewOverlay from "@src/components/ImagePreviewOverlay";
import { uint8ArrayToDataUrl } from "@src/util/file/binaryUtils";
import { getImageMimeType } from "@src/util/file/previewTypes";
import { openFileInEditor } from "@src/util/ui/openFileInEditor";
import { openFileInWorkStation } from "@src/util/ui/openFileInWorkStation";

import { parseMarkdownFileRef } from "./markdownFileRef";
import { classifyMarkdownImageSrc } from "./markdownImageSrc";

export async function resolveLocalMarkdownPath(
  path: string,
  homeRelative: boolean
): Promise<string> {
  return homeRelative ? await join(await homeDir(), path) : path;
}

/**
 * Open a local path referenced from chat markdown: directories reveal in
 * the editor tree, files open in the WorkStation preview tab (which shows
 * a not-found state for missing paths).
 */
export async function openLocalMarkdownRef(
  path: string,
  homeRelative: boolean
): Promise<void> {
  const fileRef = parseMarkdownFileRef(path);
  const absolutePath = await resolveLocalMarkdownPath(
    fileRef.path,
    homeRelative
  );
  let isDirectory = false;
  try {
    isDirectory = (await stat(absolutePath)).isDirectory;
  } catch {
    isDirectory = false;
  }
  if (isDirectory) {
    openFileInEditor(absolutePath, { isDirectory: true });
  } else if (fileRef.line !== undefined) {
    openFileInWorkStation(absolutePath, { line: fileRef.line });
  } else {
    openFileInWorkStation(absolutePath);
  }
}

async function loadLocalImage(
  path: string,
  homeRelative: boolean
): Promise<string> {
  const absolutePath = await resolveLocalMarkdownPath(path, homeRelative);
  const mimeType = getImageMimeType(absolutePath) ?? "image/png";
  const data = await readFile(absolutePath);
  return uint8ArrayToDataUrl(data, mimeType);
}

function imageLabel(alt: string | undefined, path: string): string {
  if (alt?.trim()) return alt.trim();
  const basename = path.split(/[\\/]/).pop();
  return basename || path;
}

function containClick(event: React.MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

interface MarkdownLocalImageProps {
  src?: string;
  alt?: string;
  workspaceRootPath?: string | null;
}

interface LocalImageState {
  sourceKey: string | null;
  asyncSrc: string | null;
  failed: boolean;
  showOverlay: boolean;
}

function createLocalImageState(sourceKey: string | null): LocalImageState {
  return { sourceKey, asyncSrc: null, failed: false, showOverlay: false };
}

const MarkdownLocalImage: React.FC<MarkdownLocalImageProps> = memo(
  ({ src, alt, workspaceRootPath }) => {
    const source = useMemo(
      () => classifyMarkdownImageSrc(src, workspaceRootPath),
      [src, workspaceRootPath]
    );
    const localIsImage =
      source.kind === "local" && getImageMimeType(source.path) !== undefined;
    const sourceKey =
      source.kind === "local" && localIsImage
        ? `${source.homeRelative === true ? "home" : "absolute"}:${source.path}`
        : null;
    const [imageState, setImageState] = useState<LocalImageState>(() =>
      createLocalImageState(sourceKey)
    );
    const nextImageState =
      imageState.sourceKey === sourceKey
        ? imageState
        : createLocalImageState(sourceKey);
    if (nextImageState !== imageState) {
      setImageState(nextImageState);
    }
    const { asyncSrc, failed, showOverlay } = nextImageState;

    useEffect(() => {
      if (source.kind !== "local" || !localIsImage) return;
      let cancelled = false;
      loadLocalImage(source.path, source.homeRelative === true)
        .then((dataUrl) => {
          if (!cancelled) {
            setImageState((current) =>
              current.sourceKey === sourceKey
                ? { ...current, asyncSrc: dataUrl, failed: false }
                : current
            );
          }
        })
        .catch(() => {
          if (!cancelled) {
            setImageState((current) =>
              current.sourceKey === sourceKey
                ? { ...current, asyncSrc: null, failed: true }
                : current
            );
          }
        });
      return () => {
        cancelled = true;
      };
    }, [localIsImage, source, sourceKey]);

    const handleImageClick = useCallback((event: React.MouseEvent) => {
      containClick(event);
      setImageState((current) => ({ ...current, showOverlay: true }));
    }, []);

    const handleFileChipClick = useCallback(
      (event: React.MouseEvent) => {
        containClick(event);
        if (source.kind !== "local") return;
        void openLocalMarkdownRef(source.path, source.homeRelative === true);
      },
      [source]
    );

    const handleClose = useCallback(() => {
      setImageState((current) => ({ ...current, showOverlay: false }));
    }, []);

    if (source.kind === "skip") {
      return alt?.trim() ? (
        <span className="text-text-3">[{alt.trim()}]</span>
      ) : null;
    }

    if (source.kind === "remote") {
      return <img src={source.src} alt={alt ?? ""} loading="lazy" />;
    }

    if (!localIsImage || failed) {
      const label = imageLabel(alt, source.path);
      return (
        <span
          className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-border-2 bg-fill-1 px-2 py-1 align-middle text-xs text-text-2"
          title={source.path}
          role="button"
          tabIndex={0}
          data-image-state={failed ? "unavailable" : "file"}
          onClick={failed ? containClick : handleFileChipClick}
        >
          {failed ? (
            <ImageOff
              size={14}
              strokeWidth={1.5}
              className="shrink-0 text-text-3"
            />
          ) : (
            <FileTypeIcon fileName={label} size="small" />
          )}
          <span className="truncate">{label}</span>
        </span>
      );
    }

    if (!asyncSrc) {
      return (
        <span
          className="inline-flex h-16 w-24 items-center justify-center rounded-md border border-border-2 bg-fill-1 align-middle text-text-3"
          data-image-state="loading"
          onClick={containClick}
        >
          <ImageIcon
            size={16}
            strokeWidth={1.5}
            className="animate-pulse motion-reduce:animate-none"
          />
        </span>
      );
    }

    return (
      <>
        <img
          src={asyncSrc}
          alt={alt ?? ""}
          title={source.path}
          className="cursor-zoom-in"
          onClick={handleImageClick}
          draggable={false}
        />
        {showOverlay && (
          <ImagePreviewOverlay
            dataUrl={asyncSrc}
            fileName={imageLabel(alt, source.path)}
            onClose={handleClose}
            showCopyButton={false}
          />
        )}
      </>
    );
  }
);
MarkdownLocalImage.displayName = "MarkdownLocalImage";

export default MarkdownLocalImage;
