/**
 * Highlight Utilities
 *
 * Separator-aware text highlighting for spotlight search results.
 */
import React from "react";

const SEPARATOR_CHARS_RE = /[\s\-_.]+/g;

/**
 * Build a regex that matches the query with separators treated as interchangeable.
 * "gpt 5.2" matches "gpt-5.2", "gpt_5.2", "gpt.5.2", etc.
 */
function buildSeparatorAwarePattern(query: string): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(SEPARATOR_CHARS_RE).filter(Boolean);
  if (tokens.length === 0) return null;

  const escaped = tokens.map((tok) =>
    tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  return new RegExp(`(${escaped.join("[\\s\\-_.]+")})`, "gi");
}

/** Highlights parts of text that match the search query (separator-aware) */
export const HighlightText: React.FC<{ text: string; query: string }> = ({
  text,
  query,
}) => {
  if (!query.trim()) return <>{text}</>;

  const regex = buildSeparatorAwarePattern(query);
  if (!regex) return <>{text}</>;

  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, index) => {
        const isMatch = regex.test(part);
        regex.lastIndex = 0;
        return isMatch ? (
          <span key={index} className="text-primary-6">
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        );
      })}
    </>
  );
};
