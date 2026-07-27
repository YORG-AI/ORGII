/**
 * Compatibility export for the sidebar call sites and focused tests. The
 * owner lives under Organizations because Task Kanban and the sidebar must
 * apply the same bare/namespaced cloud-id semantics.
 */
export {
  buildSessionOrgFilterIds,
  sessionMatchesOrgFilter,
} from "@src/features/Organizations/sessionOrgScope";
