import React from "react";

import { MyRolesProfileTab } from "./components/MyRolesProfileTab";
import { MyRolesStatusTab } from "./components/MyRolesStatusTab";
import { MY_ROLES_TAB, type MyRolesTab } from "./myRolesConstants";

export { MY_ROLES_TAB } from "./myRolesConstants";
export type { MyRolesTab } from "./myRolesConstants";

interface MyRolesSectionProps {
  activeTab?: MyRolesTab;
}

const MyRolesSection: React.FC<MyRolesSectionProps> = ({
  activeTab = MY_ROLES_TAB.PRESENCE,
}) => {
  if (activeTab === MY_ROLES_TAB.PROFILE) {
    return <MyRolesProfileTab />;
  }

  return <MyRolesStatusTab />;
};

export default MyRolesSection;
