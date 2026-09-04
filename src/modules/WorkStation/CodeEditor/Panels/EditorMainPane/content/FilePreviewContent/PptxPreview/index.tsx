/**
 * PptxPreview Component
 *
 * Renders PowerPoint presentations (.pptx) by extracting slide content
 * from the OOXML zip structure using JSZip. Displays each slide's text
 * content in a card-based layout.
 */
import { readFile } from "@tauri-apps/plugin-fs";
import JSZip from "jszip";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import i18n from "@src/i18n";
import { getFileName } from "@src/util/file/pathUtils";

// ============================================
// Types
// ============================================

interface PptxPreviewProps {
  filePath: string;
  className?: string;
}

interface SlideContent {
  index: number;
  texts: string[];
}

// ============================================
// Helpers
// ============================================

function findAncestorParagraph(node: Element): Element | null {
  let current: Element | null = node.parentElement;
  while (current) {
    if (current.localName === "p") return current;
    current = current.parentElement;
  }
  return null;
}

function extractTextsFromXml(xmlString: string): string[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "application/xml");
  const textNodes = doc.getElementsByTagNameNS(
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "t"
  );
  const paragraphs: string[] = [];
  let currentParagraph = "";
  let lastParagraphEl: Element | null = null;

  for (let nodeIdx = 0; nodeIdx < textNodes.length; nodeIdx++) {
    const node = textNodes[nodeIdx];
    const text = node.textContent ?? "";
    const paragraphEl = findAncestorParagraph(node);

    if (paragraphEl && paragraphEl !== lastParagraphEl && currentParagraph) {
      paragraphs.push(currentParagraph);
      currentParagraph = "";
    }
    lastParagraphEl = paragraphEl;
    currentParagraph += text;
  }

  if (currentParagraph) {
    paragraphs.push(currentParagraph);
  }

  return paragraphs.filter((paragraph) => paragraph.trim().length > 0);
}

// ============================================
// Main Component
// ============================================

export const PptxPreview: React.FC<PptxPreviewProps> = ({
  filePath,
  className = "",
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slides, setSlides] = useState<SlideContent[]>([]);

  const fileName = useMemo(() => getFileName(filePath), [filePath]);

  useEffect(() => {
    let cancelled = false;

    readFile(filePath)
      .then((data) => {
        if (cancelled) return;
        return JSZip.loadAsync(data);
      })
      .then((zip) => {
        if (cancelled || !zip) return;

        const slideFiles = Object.keys(zip.files)
          .filter(
            (name) =>
              name.startsWith("ppt/slides/slide") && name.endsWith(".xml")
          )
          .sort((fileA, fileB) => {
            const numA = parseInt(fileA.match(/slide(\d+)/)?.[1] ?? "0", 10);
            const numB = parseInt(fileB.match(/slide(\d+)/)?.[1] ?? "0", 10);
            return numA - numB;
          });

        return Promise.all(
          slideFiles.map(async (slideFile, idx) => {
            const xml = await zip.file(slideFile)?.async("string");
            if (!xml) return { index: idx + 1, texts: [] };
            const texts = extractTextsFromXml(xml);
            return { index: idx + 1, texts };
          })
        );
      })
      .then((parsedSlides) => {
        if (cancelled || !parsedSlides) return;
        setSlides(parsedSlides);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : i18n.t("previews.loadPresentationFailed")
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

      {!loading && slides.length > 0 && (
        <div className="scrollbar-overlay flex h-full flex-col items-center gap-4 overflow-auto p-6">
          {slides.map((slide) => (
            <div
              key={slide.index}
              className="w-full max-w-[800px] rounded-lg border border-border-2 bg-fill-1 p-6"
            >
              <div className="mb-3 text-[11px] text-text-3">
                {t("previews.slideNumber", { index: slide.index })}
              </div>
              {slide.texts.length > 0 ? (
                <div className="space-y-2">
                  {slide.texts.map((text, textIdx) => (
                    <p
                      key={textIdx}
                      className={`text-text-1 ${
                        textIdx === 0
                          ? "text-[16px] font-medium"
                          : "text-[14px]"
                      }`}
                    >
                      {text}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-text-3 italic">
                  {t("previews.noTextContent")}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {!loading && slides.length === 0 && (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("previews.noSlidesFound")}
          subtitle={fileName}
          fillParentHeight
        />
      )}
    </div>
  );
};

export default PptxPreview;
