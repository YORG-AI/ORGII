/**
 * ComponentIssueModalContent
 *
 * JSX sub-components extracted from ComponentIssueModal/index.tsx:
 * - HighlightText: highlights a search query within text
 * - ComponentIssueDetailSection: a labelled section row with optional copy button
 * - ComponentIssuePayloadView: full payload detail view
 * - ComponentIssueSuggestions: component suggestions list / empty state / legend
 */
import React from "react";

import { Copy01Icon, HugeiconsIcon } from "@src/icons";
import { getConfidenceLabel } from "@src/util/config/componentMapping";
import type { ComponentIssuePayload } from "@src/util/core/error/componentIssueTracker/";

// ── HighlightText ─────────────────────────────────────────────────────────────

export const HighlightText: React.FC<{ text: string; query: string }> = ({
  text,
  query,
}) => {
  if (!query.trim()) return <>{text}</>;
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escapedQuery})`, "gi");
  const parts = text.split(regex);
  const lowerQuery = query.toLowerCase();
  return (
    <>
      {parts.map((part, index) => {
        const isMatch = part.toLowerCase() === lowerQuery;
        return isMatch ? (
          <mark key={index} className="component-issue-highlight">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        );
      })}
    </>
  );
};

// ── ComponentIssueDetailSection ───────────────────────────────────────────────

interface DetailSectionProps {
  label: string;
  value: React.ReactNode;
  description?: string;
  copyValue?: string;
  onCopyField: (label: string, value?: string) => void;
}

export function ComponentIssueDetailSection({
  label,
  value,
  description,
  copyValue,
  onCopyField,
}: DetailSectionProps) {
  return (
    <div className="component-issue-section">
      <div className="component-issue-label">
        <div className="component-issue-label-text">
          <span>{label}</span>
          {description && (
            <span className="component-issue-hint">{description}</span>
          )}
        </div>
        {copyValue && (
          <button
            className="component-issue-copy-btn"
            onClick={() => onCopyField(label, copyValue)}
            aria-label={`Copy ${label}`}
          >
            <HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={16} />
          </button>
        )}
      </div>
      <div className="component-issue-value">{value}</div>
    </div>
  );
}

// ── ComponentIssueSuggestions ─────────────────────────────────────────────────

interface SuggestionsProps {
  payload: ComponentIssuePayload;
  searchQuery: string;
  onCopyField: (label: string, value?: string) => void;
}

export function ComponentIssueSuggestions({
  payload,
  searchQuery,
  onCopyField,
}: SuggestionsProps) {
  const suggestions = payload.componentSuggestions;
  return (
    <>
      <div className="component-issue-section">
        <div className="component-issue-label">
          <div className="component-issue-label-text">
            <span>Component Suggestions</span>
            {suggestions && suggestions.length > 0 && (
              <span className="component-issue-hint">
                {suggestions.length} match{suggestions.length !== 1 ? "es" : ""}
              </span>
            )}
          </div>
        </div>
      </div>

      {suggestions && suggestions.length > 0 ? (
        <div className="component-issue-suggestions-list">
          {suggestions.map((suggestion, idx) => (
            <div key={idx} className="component-issue-suggestion-item">
              <div className="component-issue-suggestion-header">
                <span className="component-issue-confidence">
                  {getConfidenceLabel(suggestion.confidence)}
                </span>
                <span className="component-issue-suggestion-name">
                  <HighlightText text={suggestion.name} query={searchQuery} />
                </span>
                <button
                  className="component-issue-suggestion-copy"
                  onClick={() => onCopyField("File path", suggestion.filePath)}
                  title="Copy file path"
                >
                  <HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={16} />
                </button>
              </div>
              <div className="component-issue-suggestion-file">
                <HighlightText text={suggestion.filePath} query={searchQuery} />
              </div>
              <div className="component-issue-suggestion-reason">
                <HighlightText
                  text={suggestion.matchReason}
                  query={searchQuery}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="component-issue-empty-suggestions">
          <div className="component-issue-empty-icon">🔍</div>
          <div className="component-issue-empty-text">
            No component suggestions found
          </div>
          <div className="component-issue-empty-hint">
            The element does not match any known component patterns
          </div>
        </div>
      )}

      <div className="component-issue-legend">
        <div className="component-issue-legend-title">Confidence Legend</div>
        <div className="component-issue-legend-items">
          <span>🟢 High - Exact pattern match</span>
          <span>🟡 Medium - Partial or parent match</span>
          <span>🔴 Low - Generic pattern inference</span>
        </div>
      </div>
    </>
  );
}

// ── ComponentIssuePayloadView ─────────────────────────────────────────────────

interface PayloadViewProps {
  payload: ComponentIssuePayload;
  searchQuery: string;
  contentRef: React.RefObject<HTMLDivElement>;
  onCopyField: (label: string, value?: string) => void;
}

export function ComponentIssuePayloadView({
  payload,
  searchQuery,
  contentRef,
  onCopyField,
}: PayloadViewProps) {
  const hl = (text: string) => (
    <code className="component-issue-code">
      <HighlightText text={text} query={searchQuery} />
    </code>
  );

  return (
    <div className="component-issue-modal-content" ref={contentRef}>
      <ComponentIssueDetailSection
        label="Component Label"
        value={hl(payload.componentLabel)}
        description="data-component / aria-label / id / tag"
        copyValue={payload.componentLabel}
        onCopyField={onCopyField}
      />
      <ComponentIssueDetailSection
        label="Dimensions"
        value={
          <code className="component-issue-code">
            {`${Math.round(payload.boundingRect.width)}px × ${Math.round(payload.boundingRect.height)}px`}
            {payload.styleSnapshot["z-index"] &&
              payload.styleSnapshot["z-index"] !== "auto" && (
                <span style={{ marginLeft: "12px", opacity: 0.7 }}>
                  z-index: {payload.styleSnapshot["z-index"]}
                </span>
              )}
          </code>
        }
        description="Width × Height (z-index if set)"
        onCopyField={onCopyField}
      />
      <ComponentIssueDetailSection
        label="CSS Selector"
        value={hl(payload.cssSelector)}
        description="Use with document.querySelector"
        copyValue={payload.cssSelector}
        onCopyField={onCopyField}
      />
      <ComponentIssueDetailSection
        label="DOM Path"
        value={hl(payload.domPath.join(" → "))}
        description="High-level location"
        copyValue={payload.domPath.join(" -> ")}
        onCopyField={onCopyField}
      />
      {payload.reactComponent?.name && (
        <ComponentIssueDetailSection
          label="React Component"
          value={hl(payload.reactComponent.name)}
          description="Detected from React fiber"
          copyValue={payload.reactComponent.name}
          onCopyField={onCopyField}
        />
      )}
      {payload.position && payload.position.position !== "static" && (
        <ComponentIssueDetailSection
          label="Position"
          value={
            <code className="component-issue-code">
              {payload.position.position}
              {payload.position.top !== "auto" &&
                ` • top: ${payload.position.top}`}
              {payload.position.left !== "auto" &&
                ` • left: ${payload.position.left}`}
              {payload.position.right !== "auto" &&
                ` • right: ${payload.position.right}`}
              {payload.position.bottom !== "auto" &&
                ` • bottom: ${payload.position.bottom}`}
            </code>
          }
          description="CSS positioning"
          onCopyField={onCopyField}
        />
      )}
      {payload.contextClues?.nearbyText && (
        <ComponentIssueDetailSection
          label="Nearby Text"
          value={hl(payload.contextClues.nearbyText)}
          description="Text from sibling elements"
          onCopyField={onCopyField}
        />
      )}
      {payload.contextClues?.siblingElements && (
        <ComponentIssueDetailSection
          label="Sibling Elements"
          value={hl(payload.contextClues.siblingElements.join(", "))}
          description="Elements at same level"
          onCopyField={onCopyField}
        />
      )}
      {payload.contextClues?.eventHandlers && (
        <ComponentIssueDetailSection
          label="Event Handlers"
          value={hl(payload.contextClues.eventHandlers.join(", "))}
          description="Attached event listeners"
          onCopyField={onCopyField}
        />
      )}
      {payload.contextClues?.ariaAttributes && (
        <ComponentIssueDetailSection
          label="ARIA Attributes"
          value={
            <code className="component-issue-code">
              {Object.entries(payload.contextClues.ariaAttributes).map(
                ([key, value]) => (
                  <div key={key}>
                    <HighlightText
                      text={`${key}="${value}"`}
                      query={searchQuery}
                    />
                  </div>
                )
              )}
            </code>
          }
          description="Accessibility attributes"
          onCopyField={onCopyField}
        />
      )}
      <ComponentIssueSuggestions
        payload={payload}
        searchQuery={searchQuery}
        onCopyField={onCopyField}
      />
    </div>
  );
}
