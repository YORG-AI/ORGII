import { useAtom } from "jotai";
import React, { memo, useCallback } from "react";

import {
  WORK_MANAGEMENT_SESSION_CREATOR_OVERLAY_CLASS,
  WORK_MANAGEMENT_SESSION_CREATOR_SURFACE_CLASS,
} from "@src/config/workManagementCardTokens";
import { SessionCreatorKanban } from "@src/features/SessionCreator/variants";
import { workManagementCreatorVisibleAtom } from "@src/store/ui/workManagementCreatorAtom";

const WorkManagementTaskCreator: React.FC = memo(() => {
  const [visible, setVisible] = useAtom(workManagementCreatorVisibleAtom);

  const handleClose = useCallback(() => {
    setVisible(false);
  }, [setVisible]);

  if (!visible) return null;

  return (
    <div className={WORK_MANAGEMENT_SESSION_CREATOR_OVERLAY_CLASS}>
      <SessionCreatorKanban
        className={WORK_MANAGEMENT_SESSION_CREATOR_SURFACE_CLASS}
        onSessionStart={handleClose}
        onClose={handleClose}
      />
    </div>
  );
});

WorkManagementTaskCreator.displayName = "WorkManagementTaskCreator";

export default WorkManagementTaskCreator;
