import { Check, Minus } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import type { AddressCommentsThreadOption } from "@src/features/Org2Cloud/useAddressCommentsSlashCommand";

interface AddressCommentsFlyoutProps {
  threads: AddressCommentsThreadOption[];
  anchorTop: number;
  panelRight: number;
  onConfirm: (selectedHeadIds: string[]) => void;
  onClose: () => void;
}

const BODY_PREVIEW_MAX_CHARS = 60;

function clipBody(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > BODY_PREVIEW_MAX_CHARS
    ? `${collapsed.slice(0, BODY_PREVIEW_MAX_CHARS)}…`
    : collapsed;
}

const AddressCommentsFlyout: React.FC<AddressCommentsFlyoutProps> = ({
  threads,
  anchorTop,
  panelRight,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation("navigation");
  const panelRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(threads.map((thread) => thread.id))
  );

  useEffect(() => {
    let portalReady = false;
    const readyFrame = window.requestAnimationFrame(() => {
      portalReady = true;
    });

    const handler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const panel = panelRef.current;
      if (!panel && !portalReady) return;
      if (panel?.contains(target)) return;
      if (document.querySelector("[data-slash-portal]")?.contains(target)) {
        return;
      }
      onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => {
      window.cancelAnimationFrame(readyFrame);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  const allSelected = selected.size === threads.length;
  const scopeGroups = (["session", "round"] as const)
    .map((scope) => ({
      scope,
      threads: threads.filter((thread) => thread.scope === scope),
    }))
    .filter((group) => group.threads.length > 0);

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (): void => {
    setSelected(
      allSelected ? new Set() : new Set(threads.map((thread) => thread.id))
    );
  };

  const toggleScope = (scope: "session" | "round"): void => {
    const scopeIds = threads
      .filter((thread) => thread.scope === scope)
      .map((thread) => thread.id);
    const scopeAllSelected = scopeIds.every((id) => selected.has(id));
    setSelected((current) => {
      const next = new Set(current);
      for (const id of scopeIds) {
        if (scopeAllSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const checkboxClass = (checked: boolean): string =>
    `flex size-3.5 shrink-0 items-center justify-center rounded-sm border ${
      checked ? "border-primary-6 bg-primary-6 text-white" : "border-border-2"
    }`;

  return createPortal(
    <div
      ref={panelRef}
      data-testid="address-comments-flyout"
      className={`${DROPDOWN_CLASSES.panel} flex flex-col overflow-hidden`}
      style={{
        position: "fixed",
        top: anchorTop,
        left: panelRight + DROPDOWN_PANEL.submenuGap,
        minWidth: 220,
        maxWidth: 300,
        zIndex: DROPDOWN_PANEL.portalSubmenuZIndex,
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        className={`max-h-[280px] overflow-y-auto ${DROPDOWN_PANEL.paddingClass}`}
      >
        <div
          data-testid="address-comments-select-all"
          role="menuitemcheckbox"
          aria-checked={allSelected}
          className={`${DROPDOWN_CLASSES.item} cursor-pointer gap-2`}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleAll();
          }}
        >
          <span className={checkboxClass(allSelected)}>
            {allSelected && <Check size={10} strokeWidth={3} />}
          </span>
          <span className="text-[13px] text-text-1">
            {t("cloud.comments.addressSelectAll")}
          </span>
        </div>
        {scopeGroups.map(({ scope, threads: scopedThreads }) => {
          const selectedCount = scopedThreads.filter((thread) =>
            selected.has(thread.id)
          ).length;
          const scopeAllSelected = selectedCount === scopedThreads.length;
          const scopePartiallySelected = selectedCount > 0 && !scopeAllSelected;
          return (
            <div key={scope} className="mt-1 first:mt-0">
              <div
                data-testid={`address-comments-scope-${scope}`}
                role="menuitemcheckbox"
                aria-checked={
                  scopePartiallySelected ? "mixed" : scopeAllSelected
                }
                className={`${DROPDOWN_CLASSES.item} cursor-pointer gap-2`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleScope(scope);
                }}
              >
                <span
                  className={checkboxClass(
                    scopeAllSelected || scopePartiallySelected
                  )}
                >
                  {scopeAllSelected && <Check size={10} strokeWidth={3} />}
                  {scopePartiallySelected && (
                    <Minus size={10} strokeWidth={3} />
                  )}
                </span>
                <span className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-wide text-text-2">
                  {t(
                    scope === "session"
                      ? "cloud.comments.addressSessionScope"
                      : "cloud.comments.addressRoundScope"
                  )}
                </span>
                <span className="text-[11px] tabular-nums text-text-3">
                  {selectedCount}/{scopedThreads.length}
                </span>
              </div>
              {scopedThreads.map((thread) => {
                const checked = selected.has(thread.id);
                return (
                  <div
                    key={thread.id}
                    data-testid="address-comments-thread-option"
                    data-comment-scope={thread.scope}
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    className={`${DROPDOWN_CLASSES.item} cursor-pointer gap-2 pl-6`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toggle(thread.id);
                    }}
                  >
                    <span className={checkboxClass(checked)}>
                      {checked && <Check size={10} strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 truncate text-[13px]">
                      <span className="font-medium text-text-1">
                        {thread.author || "—"}
                      </span>
                      <span className="text-text-3">
                        {" "}
                        {clipBody(thread.body)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div
        className={`border-t border-border-1 ${DROPDOWN_PANEL.paddingClass}`}
      >
        <button
          type="button"
          data-testid="address-comments-confirm"
          disabled={selected.size === 0}
          className={`${DROPDOWN_CLASSES.item} w-full cursor-pointer justify-center text-[13px] font-medium ${
            selected.size === 0
              ? "cursor-default text-text-3"
              : "text-primary-6 hover:bg-fill-2"
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (selected.size === 0) return;
            onConfirm(
              threads
                .map((thread) => thread.id)
                .filter((id) => selected.has(id))
            );
          }}
        >
          {t("cloud.comments.addressConfirm", { count: selected.size })}
        </button>
      </div>
    </div>,
    document.body
  );
};

AddressCommentsFlyout.displayName = "AddressCommentsFlyout";

export default AddressCommentsFlyout;
