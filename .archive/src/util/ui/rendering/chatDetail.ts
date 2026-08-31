/**
 * Extract text content from HTML string with file path handling
 *
 * @param textToSubmit - HTML string to extract text from
 * @returns Cleaned text content
 */
export const extractTexts = (textToSubmit: string): string => {
  // Parse HTML string using DOMParser
  const parser = new DOMParser();
  const doc = parser.parseFromString(textToSubmit, "text/html");

  // Replace all spans with data-full-path attribute with their full paths (without @ symbol)
  const fileSpans = doc.querySelectorAll("span[data-full-path]");
  fileSpans.forEach((span) => {
    const fullPath = span.getAttribute("data-full-path");
    if (fullPath) {
      span.textContent = fullPath; // Use full path directly, without adding @
    }
  });

  // Extract text content and clean up
  const fullText = doc.body.textContent || "";
  return fullText.replace(/\u200B/g, "").trim();
};
