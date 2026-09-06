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
import React, { useEffect, useMemo, useState } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { getFileName } from "@src/util/file/pathUtils";

import "../DocxPreview/index.scss";
import { useStreamedFileSource } from "../useStreamedFileSource";

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

/** Outcome of converting one document; matched to the current `filePath`. */
interface ConversionState {
  path: string;
  kind: "html" | "pdf" | "error";
  data: string;
}

// ============================================
// Main Component
// ============================================

export const PagesPreview: React.FC<PagesPreviewProps> = ({
  filePath,
  className = "",
}) => {
  const [conversion, setConversion] = useState<ConversionState | null>(null);

  const fileName = useMemo(() => getFileName(filePath), [filePath]);

  useEffect(() => {
    let cancelled = false;

    invoke<PagesPreviewResult>("convert_pages_to_html", { filePath })
      .then((result) => {
        if (cancelled) return;
        setConversion({ path: filePath, kind: result.kind, data: result.data });
      })
      .catch((err) => {
        if (cancelled) return;
        setConversion({
          path: filePath,
          kind: "error",
          data: typeof err === "string" ? err : "Failed to load Pages document",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // A result for a previous document is not this document's result.
  const current = conversion?.path === filePath ? conversion : null;
  const converting = current === null;
  const convertError = current?.kind === "error" ? current.data : null;
  const htmlContent = current?.kind === "html" ? current.data : null;
  // Path of the PDF the Rust side exported; streamed like any other PDF.
  const pdfPath = current?.kind === "pdf" ? current.data : null;

  const {
    src: pdfSrc,
    loading: pdfLoading,
    error: pdfError,
  } = useStreamedFileSource({
    filePath: pdfPath,
    mimeType: "application/pdf",
    probe: true,
  });

  const loading = converting || (pdfPath !== null && pdfLoading);
  const error = convertError ?? pdfError;

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

      {pdfSrc && (
        <iframe
          src={pdfSrc}
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
