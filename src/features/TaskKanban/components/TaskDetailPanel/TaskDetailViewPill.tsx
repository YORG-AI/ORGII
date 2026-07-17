/**
 * TaskDetailViewPill
 *
 * Header toggle for the Kanban session detail panel. Switches the body between
 * the session trajectory (ChatView replay) and the flat "touched files" list.
 * Controlled — the panel owns the active view.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import TabPill, { type TabPillItem } from "@src/components/TabPill";

export type TaskDetailView = "trajectory" | "touched";

interface TaskDetailViewPillProps {
  activeView: TaskDetailView;
  onChange: (view: TaskDetailView) => void;
}

const TaskDetailViewPill: React.FC<TaskDetailViewPillProps> = ({
  activeView,
  onChange,
}) => {
  const { t } = useTranslation("sessions");

  const tabs = useMemo<TabPillItem[]>(
    () => [
      { key: "trajectory", label: t("kanban.detailView.trajectory") },
      { key: "touched", label: t("kanban.detailView.touchedFiles") },
    ],
    [t]
  );

  return (
    <TabPill
      activeTab={activeView}
      tabs={tabs}
      onChange={(key) => onChange(key as TaskDetailView)}
      variant="pill"
      color="fill"
      fillWidth={false}
      size="small"
    />
  );
};

export default TaskDetailViewPill;
