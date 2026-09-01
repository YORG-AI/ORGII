import {
  PanelHeader,
  PanelRefreshButton,
  ScrollFadeContainer,
} from "@/src/modules/shared/layouts/blocks";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import type { LearningRecord } from "@src/api/tauri/rpc/schemas/learning";
import Message from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import { buildSettingsPath } from "@src/config/mainAppPaths";
import { useLearningsBrowser } from "@src/hooks/settings";

import { LearningExpandedCard } from "./LearningExpandedCard";
import { LearningsStatusCard } from "./LearningsStatusCard";
import { LearningsTable, getNextLearningsLimit } from "./LearningsTable";
import { LEARNINGS_PAGE_SIZE, READ_ONLY_LEARNING_STATUSES } from "./constants";
import type {
  LearningsBrowserToolbarRefreshApi,
  LearningsBrowserVariant,
} from "./types";
import { useLearningsTableConfig } from "./useLearningsTableConfig";

export type { LearningsBrowserToolbarRefreshApi, LearningsBrowserVariant };

export interface LearningsBrowserContentProps {
  variant: LearningsBrowserVariant;
  onClose?: () => void;
  onToolbarRefreshApiChange?: (
    api: LearningsBrowserToolbarRefreshApi | null
  ) => void;
  lockedAgentScope?: string;
  agentScopes?: string[];
  agentScopeLabels?: Record<string, string>;
}

export const LearningsBrowserContent: React.FC<
  LearningsBrowserContentProps
> = ({
  variant,
  onClose,
  onToolbarRefreshApiChange,
  lockedAgentScope,
  agentScopes,
  agentScopeLabels,
}) => {
  const { t } = useTranslation("settings");
  const navigate = useNavigate();
  const {
    items,
    loading,
    error,
    filters,
    status,
    setFilters,
    refresh,
    setStatus,
    remove,
  } = useLearningsBrowser({ agentScopes });
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(LEARNINGS_PAGE_SIZE);
  const [expandedLearningKeys, setExpandedLearningKeys] = useState<string[]>(
    []
  );

  useEffect(() => {
    if (!lockedAgentScope) return;
    if (filters.agentScope === lockedAgentScope) return;
    setFilters({ ...filters, agentScope: lockedAgentScope });
  }, [lockedAgentScope, filters, setFilters]);

  useEffect(() => {
    setVisibleLimit(LEARNINGS_PAGE_SIZE);
  }, [
    agentScopes,
    filters.search,
    filters.status,
    filters.source,
    filters.category,
    filters.agentScope,
  ]);

  useEffect(() => {
    if (variant !== "integrationsPanel" || !onToolbarRefreshApiChange) return;
    onToolbarRefreshApiChange({ refresh, loading });
    return () => onToolbarRefreshApiChange(null);
  }, [variant, onToolbarRefreshApiChange, refresh, loading]);

  const handleBack = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    navigate(buildSettingsPath({ section: "general" }));
  }, [onClose, navigate]);

  const handleSearchChange = useCallback(
    (value: string) => {
      setFilters({ ...filters, search: value || undefined });
    },
    [filters, setFilters]
  );

  const runAction = useCallback(
    async (id: string, promise: Promise<void>, successKey: string) => {
      setActioningId(id);
      try {
        await promise;
        Message.success({ content: t(successKey) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Message.error({ content: message });
      } finally {
        setActioningId(null);
      }
    },
    [t]
  );

  const handlePromote = useCallback(
    (row: LearningRecord) => {
      void runAction(
        row.id,
        setStatus(row.id, "active"),
        "learningsBrowser.toast.promoted"
      );
    },
    [runAction, setStatus]
  );

  const handleDeprecate = useCallback(
    (row: LearningRecord) => {
      void runAction(
        row.id,
        setStatus(row.id, "deprecated"),
        "learningsBrowser.toast.deprecated"
      );
    },
    [runAction, setStatus]
  );

  const handleReactivate = useCallback(
    (row: LearningRecord) => {
      void runAction(
        row.id,
        setStatus(row.id, "active"),
        "learningsBrowser.toast.reactivated"
      );
    },
    [runAction, setStatus]
  );

  const handleDelete = useCallback(
    (row: LearningRecord) => {
      void runAction(row.id, remove(row.id), "learningsBrowser.toast.deleted");
    },
    [runAction, remove]
  );

  const getAgentLabel = useCallback(
    (row: LearningRecord) =>
      agentScopeLabels?.[row.agent_scope] ?? row.agent_scope,
    [agentScopeLabels]
  );

  const getCategoryLabel = useCallback(
    (row: LearningRecord) =>
      t(`learningsBrowser.category.${row.category}`, row.category),
    [t]
  );

  const setSingleExpandedLearning = useCallback((row: LearningRecord) => {
    setExpandedLearningKeys((current) =>
      current.includes(row.id) ? [] : [row.id]
    );
  }, []);

  const { columns, selectFilters } = useLearningsTableConfig({
    variant,
    filters,
    setFilters,
    actioningId,
    t,
    getAgentLabel,
    getCategoryLabel,
    handlePromote,
    handleDeprecate,
    handleReactivate,
    handleDelete,
  });

  const filteredItems = useMemo(
    () =>
      variant === "integrationsPanel"
        ? items.filter(
            (row) => !READ_ONLY_LEARNING_STATUSES.includes(row.status)
          )
        : items,
    [variant, items]
  );

  const visibleItems = useMemo(
    () => filteredItems.slice(0, visibleLimit),
    [filteredItems, visibleLimit]
  );

  const tableSection = (
    <LearningsTable
      variant={variant}
      loading={loading}
      filtersSearch={filters.search}
      columns={columns}
      selectFilters={selectFilters}
      visibleItems={visibleItems}
      filteredItemCount={filteredItems.length}
      expandedLearningKeys={expandedLearningKeys}
      t={t}
      onSearchChange={handleSearchChange}
      onExpandedLearningClick={setSingleExpandedLearning}
      onExpandedRowsChange={(keys) => setExpandedLearningKeys(keys.slice(-1))}
      onLoadMore={() => setVisibleLimit(getNextLearningsLimit)}
      renderExpandedLearningCard={(row) => (
        <LearningExpandedCard
          row={row}
          t={t}
          getAgentLabel={getAgentLabel}
          getCategoryLabel={getCategoryLabel}
        />
      )}
    />
  );

  if (variant === "integrationsPanel") {
    if (error) {
      return (
        <Placeholder
          variant="error"
          placement="detail-panel"
          onRetry={() => void refresh()}
        />
      );
    }
    return <>{tableSection}</>;
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <PanelHeader
        onBack={handleBack}
        breadcrumb={{
          parent: t("sections.agentMemory"),
          current: t("learningsBrowser.title"),
        }}
        actions={
          <PanelRefreshButton
            onRefresh={() => void refresh()}
            loading={loading}
          />
        }
      />

      <ScrollFadeContainer className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-6 pt-3 pb-6">
          {status && <LearningsStatusCard status={status} t={t} />}

          {error ? (
            <Placeholder
              variant="error"
              placement="sidebar"
              onRetry={() => void refresh()}
            />
          ) : (
            tableSection
          )}
        </div>
      </ScrollFadeContainer>
    </div>
  );
};
