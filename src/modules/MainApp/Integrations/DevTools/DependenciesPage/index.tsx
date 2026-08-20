/**
 * Dependencies Page
 *
 * Embedded list of system dependencies & packages. Excludes the
 * "database" category — those live in the Databases section.
 * Row selection is reported via `onSelectDep`; the parent renders the
 * preview panel (`DependenciesPreviewPanel`) outside this component.
 */
import React, { useEffect } from "react";

import type { DependencyStatus } from "@src/modules/MainApp/Integrations/hooks/useSystemDependencies";
import {
  NON_DB_CATEGORIES,
  useSystemDependencies,
} from "@src/modules/MainApp/Integrations/hooks/useSystemDependencies";

import DependenciesTable from "./Table/DependenciesTable";

interface DependenciesPageProps {
  selectedDep?: DependencyStatus | null;
  onSelectDep?: (dep: DependencyStatus | null) => void;
  /** Parent passes a ref to receive the refresh callback for the preview panel. */
  refreshRef?: React.MutableRefObject<(() => Promise<void>) | null>;
}

const DependenciesPage: React.FC<DependenciesPageProps> = ({
  selectedDep,
  onSelectDep,
  refreshRef,
}) => {
  const { isLoading, refresh, byCategory } = useSystemDependencies();
  const deps = byCategory(NON_DB_CATEGORIES);

  useEffect(() => {
    if (refreshRef) {
      refreshRef.current = refresh;
      return () => {
        refreshRef.current = null;
      };
    }
  }, [refreshRef, refresh]);

  return (
    <DependenciesTable
      dependencies={deps}
      loading={isLoading}
      selectedDepId={selectedDep?.binary ?? null}
      onSelectDep={onSelectDep}
    />
  );
};

export default DependenciesPage;
