/**
 * VideoPreview Component
 *
 * Displays video files using the native browser <video> element.
 * Uses readFile + a blob URL (same approach as ImagePreview) so the file
 * is served from memory rather than via convertFileSrc / asset protocol,
 * which has a restricted scope in tauri.conf.json and requires extra CSP
 * headers. The FS plugin already has home-recursive read access.
 *
 * Layout mirrors ImagePreview: scrollable viewport + fixed PreviewBottomBar.
 *
 * Supported formats: mp4, webm, mov, avi, mkv, ogv
 */
import { readFile } from "@tauri-apps/plugin-fs";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Placeholder } from "@src/components/Placeholder";
import { getFileName } from "@src/util/file/pathUtils";
import { getVideoMimeType } from "@src/util/file/previewTypes";

import { PreviewBottomBar, formatFileSize } from "../PreviewBottomBar";

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
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);

  const fileName = useMemo(() => getFileName(filePath), [filePath]);
  const mimeType = useMemo(
    () => getVideoMimeType(filePath) ?? "video/mp4",
    [filePath]
  );

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    async function loadVideo() {
      setLoading(true);
      setError(null);
      setBlobUrl(null);
      setMetadata(null);
      setFileSize(null);

      try {
        const data = await readFile(filePath);
        if (cancelled) return;

        setFileSize(data.byteLength);
        const blob = new Blob([data], { type: mimeType });
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load video");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadVideo();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, mimeType]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setMetadata({
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    });
  }, []);

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
        {blobUrl && (
          <video
            ref={videoRef}
            key={blobUrl}
            src={blobUrl}
            controls
            onLoadedMetadata={handleLoadedMetadata}
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
