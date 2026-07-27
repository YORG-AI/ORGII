import React from "react";

import Avatar from "@src/components/Avatar";

import type { KanbanTaskCreator } from "../../types";

export interface TaskCreatorAvatarProps {
  creator: KanbanTaskCreator;
  size?: number;
}

export function getTaskCreatorInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = `${words[0]?.[0] ?? "?"}${words[1]?.[0] ?? ""}`;
  return initials.toLocaleUpperCase().slice(0, 2);
}

export const TaskCreatorAvatar: React.FC<TaskCreatorAvatarProps> = ({
  creator,
  size = 16,
}) => (
  <Avatar size={size} src={creator.avatarUrl} style={{ fontSize: size * 0.7 }}>
    {getTaskCreatorInitials(creator.name)}
  </Avatar>
);

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
