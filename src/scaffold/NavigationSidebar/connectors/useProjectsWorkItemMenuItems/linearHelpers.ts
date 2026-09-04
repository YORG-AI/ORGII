export function getLinearTeamOrgName(teamName: string): string {
  return `Linear / ${teamName}`;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
