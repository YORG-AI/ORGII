import { Link2, Search, X } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  type EnrichedWorkItem,
  type ProjectData,
  projectApi,
} from "@src/api/http/project";
import { linkSessionToWorkItem } from "@src/api/tauri/agent/session";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";

interface WorkItemLinkOption {
  project: ProjectData;
  item: EnrichedWorkItem;
}

interface LinkSessionToWorkItemModalProps {
  open: boolean;
  sessionId: string | null;
  onClose: () => void;
  onLinked?: (payload: {
    projectSlug: string;
    workItemId: string;
    sessionId: string;
  }) => void;
}

const LinkSessionToWorkItemModal: React.FC<LinkSessionToWorkItemModalProps> = ({
  open,
  sessionId,
  onClose,
  onLinked,
}) => {
  const { t } = useTranslation(["sessions", "common"]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [items, setItems] = useState<WorkItemLinkOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const loadItems = async () => {
      setLoading(true);
      setError(null);
      try {
        const projects = await projectApi.readProjects();
        const groups = await Promise.all(
          projects.map(async (project) => {
            const workItems = await projectApi.readWorkItemsEnriched(
              project.slug
            );
            return workItems.map((item) => ({ project, item }));
          })
        );
        if (!cancelled) {
          setItems(groups.flat());
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadItems();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setLinkingId(null);
      setError(null);
    }
  }, [open]);

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(({ project, item }) => {
      return [item.shortId, item.title, item.status, project.meta.name]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [items, query]);

  if (!open) return null;

  const handleLink = async (option: WorkItemLinkOption) => {
    if (!sessionId) return;
    setLinkingId(option.item.shortId);
    try {
      await linkSessionToWorkItem({
        sessionId,
        projectSlug: option.project.slug,
        workItemId: option.item.shortId,
        agentRole: "custom",
      });
      Message.success(t("common:toasts.sessionLinkedToWorkItem"));
      onLinked?.({
        projectSlug: option.project.slug,
        workItemId: option.item.shortId,
        sessionId,
      });
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Message.error(t("common:toasts.sessionLinkFailed", { message }));
    } finally {
      setLinkingId(null);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      data-testid="session-link-work-item-modal"
    >
      <div className="flex max-h-[78vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-solid border-border-1 bg-bg-1 shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-solid border-border-1 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-fill-2 text-text-2">
              <Link2 size={16} />
            </div>
            <div className="min-w-0">
              <h3 className="m-0 truncate text-[14px] font-semibold text-text-1">
                {t("chat.linkWorkItem.title")}
              </h3>
              <p className="m-0 mt-0.5 truncate text-[11px] text-text-3">
                {t("chat.linkWorkItem.description")}
              </p>
            </div>
          </div>
          <Button
            variant="tertiary"
            appearance="ghost"
            size="small"
            htmlType="button"
            icon={<X size={15} />}
            onClick={onClose}
            aria-label={t("common:actions.close")}
            data-testid="session-link-work-item-close"
          />
        </div>

        <div className="border-b border-solid border-border-1 p-3">
          <Input
            value={query}
            onChange={(value) => setQuery(value)}
            placeholder={t("chat.linkWorkItem.searchPlaceholder")}
            prefix={<Search size={14} />}
            data-testid="session-link-work-item-search"
          />
        </div>

        <div className="min-h-[260px] overflow-y-auto p-3">
          {loading ? (
            <div className="rounded-xl border border-dashed border-border-2 bg-fill-1 px-4 py-8 text-center text-[12px] text-text-3">
              {t("chat.linkWorkItem.loading")}
            </div>
          ) : error ? (
            <div className="border-danger/30 bg-danger/10 text-danger rounded-xl border border-solid px-4 py-3 text-[12px]">
              {error}
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-2 bg-fill-1 px-4 py-8 text-center text-[12px] text-text-3">
              {t("chat.linkWorkItem.empty")}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredItems.map((option) => {
                const isLinking = linkingId === option.item.shortId;
                return (
                  <button
                    key={`${option.project.slug}:${option.item.shortId}`}
                    type="button"
                    className="flex w-full items-start justify-between gap-3 rounded-xl border border-solid border-border-1 bg-bg-1 px-3 py-2 text-left transition-colors hover:border-border-2 hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60"
                    data-testid={`session-link-work-item-option-${option.item.shortId}`}
                    onClick={() => void handleLink(option)}
                    disabled={Boolean(linkingId)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 rounded-md bg-fill-2 px-1.5 py-0.5 font-mono text-[11px] text-text-2">
                          {option.item.shortId}
                        </span>
                        <span className="truncate text-[13px] font-medium text-text-1">
                          {option.item.title}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-[11px] text-text-3">
                        {option.project.meta.name} · {option.item.status}
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] text-text-3">
                      {isLinking
                        ? t("chat.linkWorkItem.linking")
                        : t("chat.linkWorkItem.link")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default LinkSessionToWorkItemModal;
