/**
 * useModelCatalog — OSS stub.
 *
 * The OSS build has no model catalog backend, so consumers see an empty
 * catalog and any catalog-conditional UI (e.g. CatalogDetailContent in
 * model inline cards) collapses cleanly.
 */
import { useCallback } from "react";

import type { CatalogModel } from "@src/types/model/catalog";

interface UseModelCatalogResult {
  models: CatalogModel[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const EMPTY_MODELS: CatalogModel[] = [];

export function useModelCatalog(): UseModelCatalogResult {
  const refetch = useCallback(() => {
    /* no-op */
  }, []);
  return {
    models: EMPTY_MODELS,
    loading: false,
    error: null,
    refetch,
  };
}
