/**
 * DocxPreview Component
 *
 * Renders Word documents (.docx) by converting them to HTML via mammoth.js.
 * Reads the file through Tauri FS, converts to HTML, and renders in a
 * sandboxed container with basic document styling.
 */
import { readFile } from "@tauri-apps/plugin-fs";
import { convertToHtml } from "mammoth";
import React, { useEffect, useMemo, useState } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { getFileName } from "@src/util/file/pathUtils";

import "./index.scss";

// ============================================
// Types
// ============================================

interface DocxPreviewProps {
  filePath: string;
  className?: string;
}

// ============================================
// Main Component
// ============================================

export const DocxPreview: React.FC<DocxPreviewProps> = ({
  filePath,
  className = "",
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);

  const fileName = useMemo(() => getFileName(filePath), [filePath]);

  useEffect(() => {
    let cancelled = false;

    readFile(filePath)
      .then((data) => {
        if (cancelled) return;
        return convertToHtml({ arrayBuffer: data.buffer });
      })
      .then((result) => {
        if (cancelled || !result) return;
        setHtmlContent(result.value);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load document"
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
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

      {htmlContent !== null && (
        <div className="scrollbar-overlay h-full overflow-auto p-6">
          <div
            className="docx-preview mx-auto max-w-[800px] text-[14px] leading-relaxed text-text-1"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        </div>
      )}
    </div>
  );
};

export default DocxPreview;
