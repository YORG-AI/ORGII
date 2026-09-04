/**
 * PagesPreview Component
 *
 * Renders Apple Pages documents (.pages) on macOS. The Rust backend tries
 * three strategies in order:
 *   1. textutil → rich HTML (older .pages)
 *   2. Pages.app export → PDF with selectable text (modern .pages)
 *   3. Quick Look → image thumbnail (fallback)
 *
 * The result `kind` tells us how to render: "html" in a div, "pdf" in an iframe.
 */
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import React, { useEffect, useMemo, useState } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { getFileName } from "@src/util/file/pathUtils";

import "../DocxPreview/index.scss";

// ============================================
// Types
// ============================================

interface PagesPreviewResult {
  kind: "html" | "pdf";
  data: string;
}

interface PagesPreviewProps {
  filePath: string;
  className?: string;
}

// ============================================
// Main Component
// ============================================

export const PagesPreview: React.FC<PagesPreviewProps> = ({
  filePath,
  className = "",
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);

  const fileName = useMemo(() => getFileName(filePath), [filePath]);

  useEffect(() => {
    let cancelled = false;

    invoke<PagesPreviewResult>("convert_pages_to_html", { filePath })
      .then(async (result) => {
        if (cancelled) return;

        if (result.kind === "pdf") {
          const pdfBytes = await readFile(result.data);
          if (cancelled) return;
          const blob = new Blob([pdfBytes], { type: "application/pdf" });
          setPdfBlobUrl(URL.createObjectURL(blob));
        } else {
          setHtmlContent(result.data);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          typeof err === "string" ? err : "Failed to load Pages document"
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
      setPdfBlobUrl((prev) => {
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

      {pdfBlobUrl && (
        <iframe
          src={pdfBlobUrl}
          title={fileName}
          className="h-full w-full border-none"
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

export default PagesPreview;
