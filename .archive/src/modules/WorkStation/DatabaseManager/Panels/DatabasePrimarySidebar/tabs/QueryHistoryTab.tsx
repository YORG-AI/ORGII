/**
 * QueryHistoryTab Configuration
 *
 * Tab configuration hook for the Query History tab.
 */
import { History } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { PrimarySidebarTab } from "@src/modules/WorkStation/shared";

import QueryHistoryContent from "../content/QueryHistoryContent";

// ============================================
// Types
// ============================================

interface UseQueryHistoryTabConfigOptions {
  connectionId: string | null;
  onRunQuery?: (sql: string) => void;
}

// ============================================
// Hook
// ============================================

export function useQueryHistoryTabConfig({
  connectionId,
  onRunQuery,
}: UseQueryHistoryTabConfigOptions): PrimarySidebarTab {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      key: "history",
      label: t("tabs.queryHistory"),
      icon: <History size={16} strokeWidth={1.75} />,
      sections: [
        {
          key: "query-history",
          title: t("labels.history"),
          content: (
            <QueryHistoryContent
              connectionId={connectionId}
              onRunQuery={onRunQuery}
            />
          ),
          defaultFlexGrow: 1,
          resizable: false,
        },
      ],
    }),
    [t, connectionId, onRunQuery]
  );
}
