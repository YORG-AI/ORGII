import React from "react";

import TeamInboxView from "./TeamInboxView";
import { useTeamInboxDataSource } from "./useTeamInboxDataSource";
import { useTeamInboxNavigation } from "./useTeamInboxNavigation";

const ConnectedTeamInboxView: React.FC = () => {
  const { dataSource } = useTeamInboxDataSource();
  const navigate = useTeamInboxNavigation();
  return <TeamInboxView dataSource={dataSource} onNavigate={navigate} />;
};

export default ConnectedTeamInboxView;
