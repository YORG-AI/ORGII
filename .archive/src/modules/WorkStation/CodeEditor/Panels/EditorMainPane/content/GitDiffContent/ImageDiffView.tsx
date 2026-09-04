/**
 * ImageDiffView Component
 *
 * Side-by-side image comparison for git diffs.
 * Shows the old (HEAD) and new (working tree) versions of an image file.
 * Loads the old version via git API (base64) and the new version from disk.
 */
import { readFile } from "@tauri-apps/plugin-fs";
import React, { useCallback, useEffect, useState } from "react";

import { getGitFileContent } from "@src/api/http/git/diff";
import { Placeholder } from "@src/components/Placeholder";
import { ImageBottomBar } from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/FilePreviewContent/ImagePreview/ImageBottomBar";
import { uint8ArrayToDataUrl } from "@src/util/file/binaryUtils";
import { getImageMimeType } from "@src/util/file/previewTypes";

import "./ImageDiffView.scss";

// ============================================
// Types
// ============================================

interface ImageDiffViewProps {
  /** Absolute file path */
  filePath: string;
  /** Relative path within repo */
  relativePath: string;
  /** Repository path */
  repoPath: string;
  /** Git file status */
  status: string;
}

interface ImageData {
  dataUrl: string;
  width: number;
  height: number;
  size: number;
}

// ============================================
// Helpers
// ============================================

function loadImageMeta(
  dataUrl: string
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = dataUrl;
  });
}

// ============================================
// Constants
// ============================================

const ZOOM_LEVELS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5];
const MIN_ZOOM = ZOOM_LEVELS[0];
const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

// ============================================
// Component
// ============================================

export const ImageDiffView: React.FC<ImageDiffViewProps> = ({
  filePath,
  relativePath,
  repoPath,
  status,
}) => {
  const [oldImage, setOldImage] = useState<ImageData | null>(null);
  const [newImage, setNewImage] = useState<ImageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState(true);

  const mimeType = getImageMimeType(filePath) || "image/png";
  const isAdded = status === "added";
  const isDeleted = status === "deleted";

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setOldImage(null);
      setNewImage(null);

      try {
        // Load old image from git (HEAD) — skip for newly added files
        if (!isAdded && repoPath) {
          const result = await getGitFileContent({
            repo_id: repoPath,
            repo_path: repoPath,
            file_path: relativePath,
            ref: "HEAD",
          });

          if (cancelled) return;

          if (result?.exists && result.content) {
            let dataUrl: string;
            if (result.encoding === "base64") {
              dataUrl = `data:${mimeType};base64,${result.content}`;
            } else {
              // Fallback: text content (shouldn't happen for images)
              dataUrl = `data:${mimeType};base64,${btoa(result.content)}`;
            }
            const meta = await loadImageMeta(dataUrl);
            if (cancelled) return;
            setOldImage({
              dataUrl,
              width: meta.width,
              height: meta.height,
              size: result.size,
            });
          }
        }

        // Load new image from disk — skip for deleted files
        if (!isDeleted) {
          const data = await readFile(filePath);
          if (cancelled) return;

          const dataUrl = uint8ArrayToDataUrl(data, mimeType);
          const meta = await loadImageMeta(dataUrl);
          if (cancelled) return;
          setNewImage({
            dataUrl,
            width: meta.width,
            height: meta.height,
            size: data.byteLength,
          });
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load images");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [filePath, relativePath, repoPath, mimeType, isAdded, isDeleted]);

  // Zoom controls
  const handleZoomIn = useCallback(() => {
    setFitMode(false);
    setZoom((prev) => {
      const nextLevel = ZOOM_LEVELS.find((level) => level > prev);
      return nextLevel ?? MAX_ZOOM;
    });
  }, []);

  const handleZoomOut = useCallback(() => {
    setFitMode(false);
    setZoom((prev) => {
      const nextLevel = [...ZOOM_LEVELS]
        .reverse()
        .find((level) => level < prev);
      return nextLevel ?? MIN_ZOOM;
    });
  }, []);

  const handleFit = useCallback(() => {
    setFitMode(true);
    setZoom(1);
  }, []);

  const handleActualSize = useCallback(() => {
    setFitMode(false);
    setZoom(1);
  }, []);

  const imageStyle = !fitMode
    ? { transform: `scale(${zoom})`, transformOrigin: "center center" }
    : undefined;

  if (loading) {
    return (
      <div className="image-diff-view image-diff-view--loading">
        <Placeholder
          variant="loading"
          placement="detail-panel"
          fillParentHeight
        />
      </div>
    );
  }

  if (error) {
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={error}
        className="image-diff-view"
      />
    );
  }

  return (
    <div className="image-diff-view">
      {/* Side-by-side panels */}
      <div className="image-diff-view__panels">
        {/* Old image (HEAD) */}
        <div className="image-diff-view__panel">
          <div className="image-diff-view__image-container">
            {oldImage ? (
              <div className="image-diff-view__image-wrapper">
                <div
                  className="image-preview__image-container checkerboard-bg"
                  style={imageStyle}
                >
                  <img
                    src={oldImage.dataUrl}
                    alt="Old version"
                    draggable={false}
                  />
                </div>
              </div>
            ) : (
              <div className="image-diff-view__empty">
                <span className="text-[12px] text-text-3">
                  {isAdded ? "File did not exist" : "Not available"}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* New image (working tree) */}
        <div className="image-diff-view__panel">
          <div className="image-diff-view__image-container">
            {newImage ? (
              <div className="image-diff-view__image-wrapper">
                <div
                  className="image-preview__image-container checkerboard-bg"
                  style={imageStyle}
                >
                  <img
                    src={newImage.dataUrl}
                    alt="New version"
                    draggable={false}
                  />
                </div>
              </div>
            ) : (
              <div className="image-diff-view__empty">
                <span className="text-[12px] text-text-3">
                  {isDeleted ? "File was deleted" : "Not available"}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Shared bottom bar */}
      <ImageBottomBar
        mode="diff"
        oldImage={oldImage}
        newImage={newImage}
        status={status}
        zoom={zoom}
        fitMode={fitMode}
        onFit={handleFit}
        onActualSize={handleActualSize}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
      />
    </div>
  );
};

export default ImageDiffView;
