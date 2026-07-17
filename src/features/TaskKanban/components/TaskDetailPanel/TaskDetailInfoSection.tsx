import React from "react";
import { useTranslation } from "react-i18next";

import type { KanbanTask } from "../../types";

interface TaskDetailInfoSectionProps {
  task: KanbanTask;
}

const TaskDetailInfoSection: React.FC<TaskDetailInfoSectionProps> = ({
  task,
}) => {
  const { t } = useTranslation("sessions");

  return (
    <div className="task-detail-panel__content">
      <div className="task-detail-panel__section">
        <h3 className="task-detail-panel__section-title">
          {t("kanban.detail.title")}
        </h3>
        <div className="task-detail-panel__task-title">{task.title}</div>
      </div>

      {task.description && (
        <div className="task-detail-panel__section">
          <h3 className="task-detail-panel__section-title">
            {t("common:common.description")}
          </h3>
          <div className="task-detail-panel__description">
            {task.description}
          </div>
        </div>
      )}

      {task.tags && task.tags.length > 0 && (
        <div className="task-detail-panel__section">
          <h3 className="task-detail-panel__section-title">
            {t("kanban.detail.tags")}
          </h3>
          <div className="task-detail-panel__tags">
            {task.tags.map((tag, index) => (
              <span key={index} className="task-detail-panel__tag">
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskDetailInfoSection;
