import React from "react";

import PersonAvatar from "@src/components/PersonAvatar";

import type { KanbanTaskCreator } from "../../types";

export interface TaskCreatorAvatarProps {
  creator: KanbanTaskCreator;
  size?: number;
}

export const TaskCreatorAvatar: React.FC<TaskCreatorAvatarProps> = ({
  creator,
  size = 16,
}) => <PersonAvatar size={size} name={creator.name} src={creator.avatarUrl} />;

export interface TaskCreatorIdentityProps extends TaskCreatorAvatarProps {
  className?: string;
  maxNameCharacters?: number;
}

export function truncateTaskCreatorName(
  name: string,
  maxCharacters: number | undefined
): string {
  if (!maxCharacters || maxCharacters < 1) return name;
  const characters = Array.from(name);
  return characters.length > maxCharacters
    ? `${characters.slice(0, maxCharacters).join("")}…`
    : name;
}

export const TaskCreatorIdentity: React.FC<TaskCreatorIdentityProps> = ({
  creator,
  size = 16,
  className,
  maxNameCharacters,
}) => (
  <span
    className={`inline-flex min-w-0 items-center gap-1.5 text-xs leading-none text-text-1 ${className ?? ""}`}
    title={creator.name}
  >
    <TaskCreatorAvatar creator={creator} size={size} />
    <span className="min-w-0 truncate">
      {truncateTaskCreatorName(creator.name, maxNameCharacters)}
    </span>
  </span>
);
