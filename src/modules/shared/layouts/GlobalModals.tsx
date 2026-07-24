/**
 * Global Modals Component
 *
 * Renders app-wide modal entry points without loading heavyweight modal bodies
 * until their trigger state is active.
 */
import { useAtomValue } from "jotai";
import React, { Suspense, useEffect, useState } from "react";

import { componentIssueModalOpenAtom } from "@src/store/ui/overlayAtom";

const ComponentIssueModalProvider = React.lazy(() =>
  import("@src/modules/shared/DevTools/ComponentIssueModal").then((module) => ({
    default: module.ComponentIssueModalProvider,
  }))
);

const ComponentIssueModalLoader: React.FC = () => {
  const componentIssueModalOpen = useAtomValue(componentIssueModalOpenAtom);
  const [eventRequestedLoad, setEventRequestedLoad] = useState(false);
  const shouldLoad = componentIssueModalOpen || eventRequestedLoad;

  useEffect(() => {
    const handleShowComponentIssue = () => {
      setEventRequestedLoad(true);
    };

    window.addEventListener("show-component-issue", handleShowComponentIssue);
    return () => {
      window.removeEventListener(
        "show-component-issue",
        handleShowComponentIssue
      );
    };
  }, []);

  if (!shouldLoad) return null;

  return <ComponentIssueModalProvider />;
};

export const GlobalModals: React.FC = () => (
  <Suspense fallback={null}>
    <ComponentIssueModalLoader />
  </Suspense>
);
