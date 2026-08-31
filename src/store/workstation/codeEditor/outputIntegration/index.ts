/**
 * Code Editor — git operation hook ref
 *
 * Jotai atom holding the git operations hook instance so non-React-tree code
 * can invoke push/pull/fetch/staging. Set from EditorIntegrations.
 */

export * from "./gitOutputAtom";
