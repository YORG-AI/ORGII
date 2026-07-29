export interface WorkItemThreadHeaderPolicy {
  showHeader: boolean;
  showSeparator: boolean;
}

export function resolveWorkItemThreadHeaderPolicy(
  hasPath: boolean,
  hasProperties: boolean
): WorkItemThreadHeaderPolicy {
  return {
    showHeader: hasPath || hasProperties,
    showSeparator: hasPath && hasProperties,
  };
}
