import { useLocation } from "react-router-dom";

import { hasSidebar } from "@src/config/sidebarRegistry";

const useIsShowSidebar = () => {
  const { pathname } = useLocation();
  return hasSidebar(pathname);
};

export default useIsShowSidebar;
export { useIsShowSidebar };
