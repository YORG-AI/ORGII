import { X } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import Input from "@src/components/Input";
import type { TeamMember } from "@src/components/TeamMemberTable";
import { POPUP_Z_INDEX } from "@src/scaffold/shared/popupTokens";
import { useOverlayLayer } from "@src/store/ui/overlayLayerAtom";

import { canonicalPairKey } from "./orgTree";

interface MemberCommunicationPanelProps {
  selectedMemberId: string | null;
  members: TeamMember[];
  pairKeys: ReadonlySet<string>;
  onPairChange: (
    memberAId: string,
    memberBId: string,
    checked: boolean
  ) => void;
  onClose: () => void;
}

export default function MemberCommunicationPanel({
  selectedMemberId,
  members,
  pairKeys,
  onPairChange,
  onClose,
}: MemberCommunicationPanelProps) {
  const { t } = useTranslation("integrations");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const selected = members.find((member) => member.id === selectedMemberId);
  useOverlayLayer(Boolean(selectedMemberId && selected));

  useEffect(() => {
    if (!selectedMemberId) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      previous?.focus();
    };
  }, [selectedMemberId]);

  const closePanel = useCallback(() => {
    setQuery("");
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!selectedMemberId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePanel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [closePanel, selectedMemberId]);

  const peers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return members.filter(
      (member) =>
        member.id !== selectedMemberId &&
        (!normalized ||
          member.name.toLocaleLowerCase().includes(normalized) ||
          member.role.toLocaleLowerCase().includes(normalized))
    );
  }, [members, query, selectedMemberId]);

  if (!selectedMemberId || !selected) return null;

  return createPortal(
    <div
      className="fixed inset-0 flex justify-end bg-black/30"
      style={{ zIndex: POPUP_Z_INDEX.content }}
      onMouseDown={closePanel}
    >
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-org-communication-panel-title"
        className="flex h-full w-full max-w-md flex-col border-l border-border-1 bg-bg-1 shadow-xl"
        data-testid="agent-orgs-communication-panel"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-1 px-4 py-3">
          <div className="min-w-0">
            <h2
              id="agent-org-communication-panel-title"
              className="truncate text-sm font-semibold text-text-1"
            >
              {t("agentOrgs.orgWizard.communicationPanel.title", {
                name: selected.name,
                defaultValue: `${selected.name} communication`,
              })}
            </h2>
            <p className="mt-1 text-xs text-text-3">
              {t(
                "agentOrgs.orgWizard.communicationPanel.coordinatorAlwaysReachable"
              )}
            </p>
          </div>
          <Button
            variant="tertiary"
            size="small"
            icon={<X size={16} />}
            iconOnly
            aria-label={t("common:actions.close")}
            onClick={closePanel}
            data-testid="agent-orgs-communication-panel-close"
          />
        </div>
        <div className="border-b border-border-1 p-4">
          <Input
            ref={searchRef}
            value={query}
            onChange={setQuery}
            placeholder={t("agentOrgs.orgWizard.communicationPanel.search")}
            data-testid="agent-orgs-communication-panel-search"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {peers.map((peer) => (
            <div
              key={peer.id}
              className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-fill-2"
              data-testid={`agent-orgs-peer-row-${peer.id}`}
            >
              <span data-testid={`agent-orgs-peer-checkbox-${peer.id}`}>
                <Checkbox
                  checked={pairKeys.has(canonicalPairKey(selected.id, peer.id))}
                  onChange={(checked) =>
                    onPairChange(selected.id, peer.id, checked)
                  }
                  ariaLabel={`${selected.name} ↔ ${peer.name}`}
                />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm text-text-1">
                  {peer.name}
                </span>
                <span className="block truncate text-xs text-text-3">
                  {peer.role}
                </span>
              </span>
            </div>
          ))}
          {peers.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-text-3">
              {t("agentOrgs.orgWizard.communicationPanel.noPeers")}
            </p>
          ) : null}
        </div>
        <p className="border-t border-border-1 px-4 py-3 text-xs text-text-3">
          {t("agentOrgs.orgWizard.communicationPanel.saveWithTeam")}
        </p>
      </aside>
    </div>,
    document.body
  );
}
