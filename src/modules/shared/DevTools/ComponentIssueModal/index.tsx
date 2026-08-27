import { useSetAtom } from "jotai";
import { Copy, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";

import Input from "@src/components/Input";
import Message from "@src/components/Message";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";
import { componentIssueModalOpenAtom } from "@src/store/ui/overlayAtom";
import {
  ComponentIssuePayload,
  buildIssuePayload,
  ensureHoverTracking,
  getEffectiveElement,
  getLastHoveredElement,
  getNextElement,
  getPreviousElement,
  setLastHoveredElement,
} from "@src/util/core/error/componentIssueTracker/";

import { ComponentIssuePayloadView } from "./ComponentIssueModalContent";
import "./index.scss";

interface ComponentIssueModalProps {
  visible: boolean;
  payload: ComponentIssuePayload | null;
  onClose: () => void;
}

interface ComponentIssueModalExtendedProps extends ComponentIssueModalProps {
  onNavigate?: (element: Element) => void;
}

const ModalComponentIssue: React.FC<ComponentIssueModalExtendedProps> = ({
  visible,
  payload,
  onClose,
  onNavigate,
}) => {
  const [searchState, setSearchState] = useState({
    query: "",
    currentMatchIndex: 0,
  });
  const { query: searchQuery, currentMatchIndex } = searchState;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleCopy = useCallback(() => {
    if (!payload) {
      Message.warning("No component data to copy.");
      return;
    }
    const copyData = {
      componentLabel: payload.componentLabel,
      cssSelector: payload.cssSelector,
      domPath: payload.domPath,
      reactComponent: payload.reactComponent,
      dimensions: {
        width: Math.round(payload.boundingRect.width),
        height: Math.round(payload.boundingRect.height),
      },
      position: payload.position,
      contextClues: payload.contextClues,
      dataAttributes: payload.dataAttributes,
      componentSuggestions: payload.componentSuggestions,
      meta: {
        url: payload.url,
        timestamp: payload.timestamp,
        viewport: payload.viewport,
      },
    };
    navigator.clipboard
      .writeText(JSON.stringify(copyData, null, 2))
      .then(() => Message.success("Component issue payload copied"))
      .catch(() => Message.error("Failed to copy payload"));
  }, [payload]);

  const handleCopyField = useCallback((label: string, value?: string) => {
    if (!value) {
      Message.warning(`No ${label.toLowerCase()} to copy.`);
      return;
    }
    navigator.clipboard
      .writeText(value)
      .then(() => Message.success(`${label} copied`))
      .catch(() => Message.error(`Failed to copy ${label.toLowerCase()}`));
  }, []);

  const getMatchingSections = useCallback(() => {
    if (!searchQuery.trim() || !contentRef.current) return [];
    const suggestions = contentRef.current.querySelectorAll(
      ".component-issue-suggestion-item"
    );
    return Array.from(suggestions).filter((suggestion) => {
      const text = suggestion.textContent?.toLowerCase() || "";
      return text.includes(searchQuery.toLowerCase());
    });
  }, [searchQuery]);

  const scrollToMatch = useCallback(
    (index: number) => {
      const matches = getMatchingSections();
      if (matches.length > 0 && matches[index]) {
        matches[index].scrollIntoView({ behavior: "smooth", block: "center" });
        matches.forEach((match, matchIndex) => {
          match.classList.toggle(
            "component-issue-section-focused",
            matchIndex === index
          );
        });
      }
    },
    [getMatchingSections]
  );

  const navigateMatch = useCallback(
    (direction: "next" | "prev") => {
      const matches = getMatchingSections();
      if (matches.length === 0) return;
      const newIndex =
        direction === "next"
          ? (currentMatchIndex + 1) % matches.length
          : currentMatchIndex <= 0
            ? matches.length - 1
            : currentMatchIndex - 1;
      setSearchState((current) => ({
        ...current,
        currentMatchIndex: newIndex,
      }));
      scrollToMatch(newIndex);
    },
    [currentMatchIndex, getMatchingSections, scrollToMatch]
  );

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "Tab" && searchQuery.trim()) {
        event.preventDefault();
        navigateMatch(event.shiftKey ? "prev" : "next");
        return;
      }
      const target = event.target;
      const fromSearch =
        target === searchInputRef.current ||
        (target instanceof Node &&
          searchInputRef.current?.contains(target) === true);
      if (event.key === "ArrowUp" && !event.shiftKey && fromSearch) {
        event.preventDefault();
        const prev = getPreviousElement(getLastHoveredElement());
        if (prev && onNavigate) onNavigate(prev);
        return;
      }
      if (event.key === "ArrowDown" && !event.shiftKey && fromSearch) {
        event.preventDefault();
        const next = getNextElement(getLastHoveredElement());
        if (next && onNavigate) onNavigate(next);
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [visible, onClose, onNavigate, searchQuery, navigateMatch]);

  useEffect(() => {
    if (!searchQuery.trim()) return;
    const timer = setTimeout(() => scrollToMatch(0), 50);
    return () => clearTimeout(timer);
  }, [searchQuery, scrollToMatch]);

  useEffect(() => {
    if (!visible || !searchInputRef.current) return;
    const timer = setTimeout(() => {
      let inputElement: HTMLInputElement | null = null;
      const ref = searchInputRef.current;
      if (ref instanceof HTMLInputElement) {
        inputElement = ref;
      } else if (ref && typeof ref === "object" && "dom" in ref) {
        inputElement = (ref as { dom?: HTMLInputElement }).dom || null;
      } else if (ref && typeof ref === "object" && "querySelector" in ref) {
        inputElement = (ref as HTMLElement).querySelector("input");
      }
      inputElement?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [visible]);

  const [matchMeasurement, setMatchMeasurement] = useState({
    query: "",
    count: 0,
  });
  const matchCount =
    visible && searchQuery.trim() && matchMeasurement.query === searchQuery
      ? matchMeasurement.count
      : 0;
  useEffect(() => {
    if (!searchQuery.trim() || !visible) return;
    const timer = setTimeout(() => {
      setMatchMeasurement({
        query: searchQuery,
        count: getMatchingSections().length,
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [searchQuery, getMatchingSections, visible]);

  if (!visible) return null;

  return ReactDOM.createPortal(
    <div className="component-issue-modal-overlay" onClick={onClose}>
      <div
        className="component-issue-modal-container"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="component-issue-modal-header">
          <div className="component-issue-modal-header-top">
            <div className="component-issue-modal-title">Component Issue</div>
            <button className="component-issue-close-btn" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
          <div className="component-issue-search-wrapper">
            <Input
              ref={searchInputRef}
              className="component-issue-search-input"
              placeholder="Search sections..."
              value={searchQuery}
              onChange={(value) =>
                setSearchState({ query: value, currentMatchIndex: 0 })
              }
              allowClear
            />
            {searchQuery.trim() && (
              <div className="component-issue-match-info">
                <span className="component-issue-match-count">
                  {matchCount > 0
                    ? `${currentMatchIndex + 1}/${matchCount}`
                    : "0"}
                </span>
                <button
                  className="component-issue-nav-btn"
                  onClick={() => navigateMatch("prev")}
                  disabled={matchCount === 0}
                  title="Previous (Shift+Tab)"
                >
                  ↑
                </button>
                <button
                  className="component-issue-nav-btn"
                  onClick={() => navigateMatch("next")}
                  disabled={matchCount === 0}
                  title="Next (Tab)"
                >
                  ↓
                </button>
              </div>
            )}
          </div>
        </div>

        {!payload ? (
          <div className="component-issue-modal-content" ref={contentRef}>
            <div className="component-issue-empty">
              Hover over the UI element first, then press{" "}
              <span className="component-issue-kbd">
                {getShortcutKeys("capture_component")}
              </span>
            </div>
          </div>
        ) : (
          <ComponentIssuePayloadView
            payload={payload}
            searchQuery={searchQuery}
            contentRef={contentRef as React.RefObject<HTMLDivElement>}
            onCopyField={handleCopyField}
          />
        )}

        <PanelFooter
          className="bg-fill-1 px-5"
          secondaryActions={[
            { label: "Close", onClick: onClose, variant: "secondary" },
          ]}
          primaryAction={{
            label: "Copy JSON",
            icon: <Copy size={16} />,
            onClick: handleCopy,
            disabled: !payload,
          }}
        />
      </div>
    </div>,
    document.body
  );
};

export const ComponentIssueModalProvider: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [payload, setPayload] = useState<ComponentIssuePayload | null>(null);
  const setComponentIssueModalOpen = useSetAtom(componentIssueModalOpenAtom);

  useEffect(() => {
    setComponentIssueModalOpen(visible);
  }, [visible, setComponentIssueModalOpen]);

  const updatePayloadFromElement = useCallback((element: Element | null) => {
    setPayload(buildIssuePayload(element));
  }, []);

  const handleNavigate = useCallback(
    (element: Element) => {
      setLastHoveredElement(element);
      updatePayloadFromElement(element);
    },
    [updatePayloadFromElement]
  );

  useEffect(() => {
    ensureHoverTracking();
    const handleShowComponentIssue = (event: Event) => {
      const customEvent = event as CustomEvent<{ element?: Element | null }>;
      const target = customEvent.detail?.element ?? getEffectiveElement();
      updatePayloadFromElement(target);
      setVisible(true);
    };
    window.addEventListener("show-component-issue", handleShowComponentIssue);
    return () => {
      window.removeEventListener(
        "show-component-issue",
        handleShowComponentIssue
      );
    };
  }, [updatePayloadFromElement]);

  return visible ? (
    <ModalComponentIssue
      visible
      payload={payload}
      onClose={() => setVisible(false)}
      onNavigate={handleNavigate}
    />
  ) : null;
};

export default ModalComponentIssue;
