/**
 * PdfPreview Component
 *
 * Displays PDF files using the browser's native PDF renderer in an iframe.
 * The document is streamed from disk through the asset protocol (probed
 * first, because an iframe cannot report a failed load); if that is not
 * available the file is read into a Blob URL as before. The webview's
 * built-in PDF controls handle zoom and page navigation.
 */
import React, { useMemo } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { getFileName } from "@src/util/file/pathUtils";

import { useStreamedFileSource } from "../useStreamedFileSource";

// ============================================
// Types
// ============================================

interface PdfPreviewProps {
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
  const fileName = useMemo(() => getFileName(filePath), [filePath]);
  const {
    src: pdfSrc,
    loading,
    error,
  } = useStreamedFileSource({
    filePath,
    mimeType: "application/pdf",
    probe: true,
  });

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
    </div>
  );
};

export default PdfPreview;
