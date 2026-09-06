/**
 * VideoPreview Component
 *
 * Displays video files using the native browser <video> element.
 * The source is streamed from disk through the asset protocol (the Rust
 * side widens the scope for exactly this file), so the webview holds no
 * copy of the video; if that fails the element falls back to a Blob URL.
 *
 * Layout mirrors ImagePreview: scrollable viewport + fixed PreviewBottomBar.
 *
 * Supported formats: mp4, webm, mov, avi, mkv, ogv
 */
import React, { useCallback, useMemo, useRef, useState } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { getFileName } from "@src/util/file/pathUtils";
import { getVideoMimeType } from "@src/util/file/previewTypes";

import { PreviewBottomBar, formatFileSize } from "../PreviewBottomBar";
import { useStreamedFileSource } from "../useStreamedFileSource";

// ============================================
// Types
// ============================================

interface VideoPreviewProps {
  /** Absolute file path to the video */
  filePath: string;
  /** Optional class name */
  className?: string;
}

interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
}

// ============================================
// Helpers
// ============================================

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ============================================
// Main Component
// ============================================

export const VideoPreview: React.FC<VideoPreviewProps> = ({
  filePath,
  className = "",
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);

  const fileName = useMemo(() => getFileName(filePath), [filePath]);
  const mimeType = useMemo(
    () => getVideoMimeType(filePath) ?? "video/mp4",
    [filePath]
  );

  const {
    src: videoSrc,
    fileSize,
    loading,
    error,
    onSourceError,
  } = useStreamedFileSource({ filePath, mimeType });

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setMetadata({
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    });
  }, []);

  const handleSourceError = useCallback(() => {
    setMetadata(null);
    onSourceError();
  }, [onSourceError]);

  if (error) {
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={error}
        subtitle={fileName}
        fillParentHeight
        className={className}
      />
    );
  }

  const bottomLeft = (
    <>
      {metadata && (
        <>
          <span>
            {metadata.width} × {metadata.height}
          </span>
          <span>{formatDuration(metadata.duration)}</span>
        </>
      )}
      {fileSize !== null && <span>{formatFileSize(fileSize)}</span>}
    </>
  );

  return (
    // flex-col mirrors ImagePreview: video viewport grows, bottom bar stays fixed
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-hidden ${className}`}
    >
      {/* Video viewport — fills available height above the bottom bar */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {loading && (
          <Placeholder
            variant="loading"
            placement="detail-panel"
            fillParentHeight
          />
        )}
        {videoSrc && (
          <video
            ref={videoRef}
            key={videoSrc}
            src={videoSrc}
            controls
            onLoadedMetadata={handleLoadedMetadata}
            onError={handleSourceError}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
            }}
          />
        )}
      </div>

      <PreviewBottomBar left={bottomLeft} />
    </div>
  );
};

export default VideoPreview;
