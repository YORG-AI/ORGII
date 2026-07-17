import React from "react";

import DetailPanelHeader from "@src/components/DetailPanelHeader";

export type TaskDetailNavigationDirection = "prev" | "next";

interface TaskDetailHeaderProps {
  title: string;
  onClose: () => void;
  onNavigate?: (direction: TaskDetailNavigationDirection) => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  actions?: React.ReactNode;
}

const TaskDetailHeader: React.FC<TaskDetailHeaderProps> = ({
  title,
  onClose,
  onNavigate,
  hasPrev,
  hasNext,
  actions,
}) => (
  <DetailPanelHeader
    title={title}
    onClose={onClose}
    onNavigate={onNavigate}
    hasPrev={hasPrev}
    hasNext={hasNext}
    actions={actions}
    draggable
  />
);

export default TaskDetailHeader;
