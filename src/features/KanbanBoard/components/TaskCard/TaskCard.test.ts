import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TaskCard from ".";
import type { KanbanTask } from "../../types";

function renderTaskCard(task: KanbanTask): string {
  return renderToStaticMarkup(createElement(TaskCard, { task }));
}

describe("TaskCard session metadata hierarchy", () => {
  it("puts the app icon beside the title and renders a text-only model before impact", () => {
    const markup = renderTaskCard({
      id: "session-1",
      title: "Find missing virtualization",
      status: "completed",
      agentLabel: "Codex App",
      agentIconId: "code",
      modelName: "gpt-5.6-sol",
      impact: {
        linesAdded: 663,
        linesRemoved: 275,
        filesChanged: 12,
        relatedCommits: 0,
        committedFiles: 0,
        committedRatePercent: 0,
      },
    });

    const titleRow = markup.indexOf("kanban-task-card__title-row");
    const agentIcon = markup.indexOf("kanban-task-card__agent-icon");
    const title = markup.indexOf("Find missing virtualization");
    const metaRow = markup.indexOf("kanban-task-card__meta-row");
    const model = markup.indexOf("GPT 5.6 Sol");
    const impact = markup.indexOf("task-impact-line");

    expect(titleRow).toBeGreaterThanOrEqual(0);
    expect(agentIcon).toBeGreaterThan(titleRow);
    expect(title).toBeGreaterThan(agentIcon);
    expect(metaRow).toBeGreaterThan(title);
    expect(model).toBeGreaterThan(metaRow);
    expect(impact).toBeGreaterThan(model);
    expect(markup).not.toContain(">Codex App<");

    const modelMarkup = markup.slice(model - 80, model);
    expect(modelMarkup).not.toContain("<svg");
  });

  it("keeps non-session impact on its existing row", () => {
    const markup = renderTaskCard({
      id: "todo-1",
      title: "Review changes",
      status: "planned",
    });

    expect(markup.indexOf("task-impact-line")).toBeLessThan(
      markup.indexOf("kanban-task-card__meta-row")
    );
    expect(markup).not.toContain("kanban-task-card__agent-icon");
  });

  it("renders the canonical icon id without re-resolving the raw CLI type", () => {
    const markup = renderTaskCard({
      id: "agent-team-session",
      title: "Coordinate release",
      status: "in_progress",
      agentLabel: "OpenCode",
      agentIconId: "network",
      cliAgentType: "opencode",
    });

    expect(markup).toContain('data-icon="network"');
  });
});
