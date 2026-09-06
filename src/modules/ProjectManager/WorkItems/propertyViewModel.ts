import type {
  PropertyDefinition,
  ScopePropertyValue,
} from "@src/api/http/project";
import type { Person } from "@src/types/core/shared";
import type { WorkItem } from "@src/types/core/workItem";

export const PROPERTY_FILTER_NONE_VALUE = "__none__";
const PROPERTY_VALUE_TOKEN_PREFIX = "json:";
const MAX_PROPERTY_FILTER_OPTIONS = 100;

export interface WorkItemPropertyFilter {
  propertyId: string;
  valueToken: string;
}

export interface PropertyFilterOption {
  value: string;
  label: string;
}

export function workItemPropertyKey(workItem: WorkItem): string {
  return workItem.shortId ?? workItem.session_id;
}

export function propertyValueToken(value: unknown): string {
  return `${PROPERTY_VALUE_TOKEN_PREFIX}${JSON.stringify(value)}`;
}

function isNoPropertyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0)
  );
}

function comparablePropertyValueTokens(value: unknown): string[] {
  if (isNoPropertyValue(value)) return [];
  if (Array.isArray(value)) return value.map(propertyValueToken);
  return [propertyValueToken(value)];
}

export function indexScopePropertyValues(
  values: readonly ScopePropertyValue[]
): ReadonlyMap<string, ReadonlyMap<string, unknown>> {
  const byItem = new Map<string, Map<string, unknown>>();
  for (const row of values) {
    const perItem = byItem.get(row.workItemId) ?? new Map<string, unknown>();
    perItem.set(row.propertyId, row.value);
    byItem.set(row.workItemId, perItem);
  }
  return byItem;
}

export function filterWorkItemsByProperty<T extends WorkItem>(
  items: readonly T[],
  filter: WorkItemPropertyFilter | null,
  valuesByItem: ReadonlyMap<string, ReadonlyMap<string, unknown>>
): T[] {
  if (!filter) return [...items];
  return items.filter((item) => {
    const value = valuesByItem
      .get(workItemPropertyKey(item))
      ?.get(filter.propertyId);
    if (filter.valueToken === PROPERTY_FILTER_NONE_VALUE) {
      return isNoPropertyValue(value);
    }
    return comparablePropertyValueTokens(value).includes(filter.valueToken);
  });
}

function actorLabel(value: unknown, memberNames: ReadonlyMap<string, string>) {
  const reference = String(value);
  const memberId = reference.startsWith("member:")
    ? reference.slice("member:".length)
    : reference;
  return memberNames.get(memberId) ?? memberId;
}

export function propertyValueLabel(
  definition: PropertyDefinition,
  value: unknown,
  memberNames: ReadonlyMap<string, string>
): string {
  if (isNoPropertyValue(value)) return "No value";
  if (definition.propertyType === "actor") {
    return actorLabel(value, memberNames);
  }
  if (definition.propertyType === "select") {
    return (
      definition.config.options.find((option) => option.id === value)?.name ??
      String(value)
    );
  }
  if (definition.propertyType === "multi_actor" && Array.isArray(value)) {
    return value.map((entry) => actorLabel(entry, memberNames)).join(", ");
  }
  if (definition.propertyType === "multi_select" && Array.isArray(value)) {
    return value
      .map(
        (entry) =>
          definition.config.options.find((option) => option.id === entry)
            ?.name ?? String(entry)
      )
      .join(", ");
  }
  if (definition.propertyType === "checkbox") {
    return value === true ? "Yes" : "No";
  }
  return String(value);
}

export function comparePropertyValues(
  definition: PropertyDefinition,
  left: unknown,
  right: unknown,
  memberNames: ReadonlyMap<string, string>
): number {
  const leftMissing = isNoPropertyValue(left);
  const rightMissing = isNoPropertyValue(right);
  if (leftMissing || rightMissing) {
    if (leftMissing === rightMissing) return 0;
    return leftMissing ? 1 : -1;
  }
  if (
    definition.propertyType === "number" &&
    typeof left === "number" &&
    typeof right === "number"
  ) {
    return left - right;
  }
  if (
    definition.propertyType === "checkbox" &&
    typeof left === "boolean" &&
    typeof right === "boolean"
  ) {
    return Number(left) - Number(right);
  }
  return propertyValueLabel(definition, left, memberNames).localeCompare(
    propertyValueLabel(definition, right, memberNames),
    undefined,
    { numeric: true, sensitivity: "base" }
  );
}

export function propertyFilterOptions(
  definition: PropertyDefinition,
  values: readonly ScopePropertyValue[],
  members: readonly Person[]
): PropertyFilterOption[] {
  const memberNames = new Map(
    members.map((member) => [member.id, member.name])
  );
  const unique = new Map<string, string>();
  const addOption = (value: unknown, label: string) => {
    if (unique.size >= MAX_PROPERTY_FILTER_OPTIONS) return;
    const token = propertyValueToken(value);
    if (!unique.has(token)) unique.set(token, label);
  };
  if (
    definition.propertyType === "select" ||
    definition.propertyType === "multi_select"
  ) {
    for (const option of definition.config.options) {
      addOption(option.id, option.name);
    }
  }
  if (
    definition.propertyType === "actor" ||
    definition.propertyType === "multi_actor"
  ) {
    for (const member of members) {
      const reference = member.id.startsWith("member:")
        ? member.id
        : `member:${member.id}`;
      addOption(reference, member.name);
    }
  }
  for (const row of values) {
    if (row.propertyId !== definition.id || isNoPropertyValue(row.value)) {
      continue;
    }
    const entries = Array.isArray(row.value) ? row.value : [row.value];
    for (const entry of entries) {
      addOption(entry, propertyValueLabel(definition, entry, memberNames));
      if (unique.size >= MAX_PROPERTY_FILTER_OPTIONS) break;
    }
    if (unique.size >= MAX_PROPERTY_FILTER_OPTIONS) break;
  }
  return [
    { value: PROPERTY_FILTER_NONE_VALUE, label: "No value" },
    ...[...unique]
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label)),
  ];
}

export function groupWorkItemsByProperty<T extends WorkItem>(
  items: readonly T[],
  definition: PropertyDefinition,
  valuesByItem: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
  members: readonly Person[]
): Array<{ key: string; label: string; items: T[] }> {
  const memberNames = new Map(
    members.map((member) => [member.id, member.name])
  );
  const groups = new Map<string, { key: string; label: string; items: T[] }>();
  for (const item of items) {
    const value = valuesByItem
      .get(workItemPropertyKey(item))
      ?.get(definition.id);
    const key = isNoPropertyValue(value)
      ? PROPERTY_FILTER_NONE_VALUE
      : propertyValueToken(value);
    const group = groups.get(key) ?? {
      key,
      label: propertyValueLabel(definition, value, memberNames),
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => {
    if (left.key === PROPERTY_FILTER_NONE_VALUE) return 1;
    if (right.key === PROPERTY_FILTER_NONE_VALUE) return -1;
    return left.label.localeCompare(right.label);
  });
}
