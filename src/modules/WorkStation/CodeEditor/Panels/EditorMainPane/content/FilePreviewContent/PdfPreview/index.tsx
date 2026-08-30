/**
 * PdfPreview Component
 *
 * Displays PDF files using the browser's native PDF renderer via blob URLs.
 * Reads the local file through Tauri FS, creates a blob URL, and renders
 * it in an iframe. The webview's built-in PDF controls handle zoom and
 * page navigation.
 */
import { readFile } from "@tauri-apps/plugin-fs";
import React, { useEffect, useMemo, useState } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { getFileName } from "@src/util/file/pathUtils";

// ============================================
// Types
// ============================================

export interface PdfPreviewProps {
  filePath: string;
  className?: string;
}

// ============================================
// Main Component
// ============================================

export const PdfPreview: React.FC<PdfPreviewProps> = ({
  filePath,
  className = "",
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  const fileName = useMemo(() => getFileName(filePath), [filePath]);

  useEffect(() => {
    let cancelled = false;

    readFile(filePath)
      .then((data) => {
        if (cancelled) return;
        const blob = new Blob([data], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        setBlobUrl(url);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load PDF");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [filePath]);

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

  return (
    <div className={`relative h-full min-h-0 overflow-hidden ${className}`}>
      {loading && (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          fillParentHeight
          className="absolute inset-0 z-10"
        />
      )}

      {blobUrl && (
        <iframe
          src={blobUrl}
          title={fileName}
          className="h-full w-full border-none"
        />
      )}
    </div>
  );
};

export default PdfPreview;
