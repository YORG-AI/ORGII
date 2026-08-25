import { dispatchTurn } from "./TurnDispatchService";

export interface ExecutePlanParams {
  sessionId: string;
  mode: string;
  model?: string;
  accountId?: string;
  workspacePath?: string;
}

export interface ExecutePlanDocumentParams extends ExecutePlanParams {
  planContent: string;
}

export interface ExecutePlanTodosParams extends ExecutePlanParams {
  todos: Array<{ content: string }>;
}

async function sendPlanMessage(
  sessionId: string,
  content: string,
  params: Omit<ExecutePlanParams, "sessionId">
): Promise<void> {
  await dispatchTurn({
    sessionId,
    content,
    turnIntentSource: "user_submit",
    mode: params.mode,
    model: params.model,
    accountId: params.accountId,
    workspacePath: params.workspacePath,
  });
}

export const PlanExecutionService = {
  async executePlanDocument({
    sessionId,
    planContent,
    ...params
  }: ExecutePlanDocumentParams): Promise<void> {
    const content =
      "Execute the following plan document. Implement each step in order and update the todo list as you complete each step.\n\n---\n\n" +
      planContent.trim();

    await sendPlanMessage(sessionId, content, params);
  },

  async executePlanFromTodos({
    sessionId,
    todos,
    ...params
  }: ExecutePlanTodosParams): Promise<void> {
    const steps = todos
      .map((todo, idx) => `${idx + 1}. ${todo.content}`)
      .join("\n");
    const content = `Execute the following plan:\n\n${steps}\n\nImplement each step in order. Update the todo list as you complete each step.`;

    await sendPlanMessage(sessionId, content, params);
  },
};
