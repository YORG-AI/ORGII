import React from "react";

import TeamInboxView from "./TeamInboxView";
import { useTeamInboxDataSource } from "./useTeamInboxDataSource";
import { useTeamInboxNavigation } from "./useTeamInboxNavigation";

const ConnectedTeamInboxView: React.FC = () => {
  const { dataSource, viewerMemberIds } = useTeamInboxDataSource();
  const navigate = useTeamInboxNavigation();
  return (
    <TeamInboxView
      dataSource={dataSource}
      viewerMemberIds={viewerMemberIds}
      onNavigate={navigate}
    />
  );
};

export default ConnectedTeamInboxView;
