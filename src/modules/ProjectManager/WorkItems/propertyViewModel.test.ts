import { describe, expect, it } from "vitest";

import type {
  PropertyDefinition,
  ScopePropertyValue,
} from "@src/api/http/project";
import type { WorkItem } from "@src/types/core/workItem";

import {
  PROPERTY_FILTER_NONE_VALUE,
  comparePropertyValues,
  filterWorkItemsByProperty,
  groupWorkItemsByProperty,
  indexScopePropertyValues,
  propertyFilterOptions,
  propertyValueToken,
} from "./propertyViewModel";

const definition: PropertyDefinition = {
  id: "reviewers",
  orgId: "org-1",
  name: "Reviewers",
  propertyType: "multi_actor",
  description: "",
  config: { options: [] },
  position: 0,
  createdAt: "2026-08-19T00:00:00Z",
  updatedAt: "2026-08-19T00:00:00Z",
};

const items = [
  { session_id: "id-1", shortId: "WI-1", name: "One" },
  { session_id: "id-2", shortId: "WI-2", name: "Two" },
  { session_id: "id-3", shortId: "WI-3", name: "Three" },
] as WorkItem[];

const values: ScopePropertyValue[] = [
  {
    propertyId: definition.id,
    workItemId: "WI-1",
    value: ["member:alice", "member:bob"],
  },
  {
    propertyId: definition.id,
    workItemId: "WI-2",
    value: null,
  },
];

describe("property view model", () => {
  it("filters multi-value properties by one member and supports __none__", () => {
    const indexed = indexScopePropertyValues(values);
    expect(
      filterWorkItemsByProperty(
        items,
        {
          propertyId: definition.id,
          valueToken: propertyValueToken("member:alice"),
        },
        indexed
      ).map((item) => item.shortId)
    ).toEqual(["WI-1"]);
    expect(
      filterWorkItemsByProperty(
        items,
        {
          propertyId: definition.id,
          valueToken: PROPERTY_FILTER_NONE_VALUE,
        },
        indexed
      ).map((item) => item.shortId)
    ).toEqual(["WI-2", "WI-3"]);
  });

  it("builds bounded distinct filter options with member labels", () => {
    expect(
      propertyFilterOptions(definition, values, [
        { id: "alice", name: "Alice" },
        { id: "bob", name: "Bob" },
      ])
    ).toEqual([
      { value: PROPERTY_FILTER_NONE_VALUE, label: "No value" },
      { value: propertyValueToken("member:alice"), label: "Alice" },
      { value: propertyValueToken("member:bob"), label: "Bob" },
    ]);
  });

  it("offers schema-backed options even when no item currently uses them", () => {
    const selectDefinition: PropertyDefinition = {
      ...definition,
      id: "risk",
      propertyType: "select",
      name: "Risk",
      config: {
        options: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
      },
    };
    expect(propertyFilterOptions(selectDefinition, [], [])).toEqual([
      { value: PROPERTY_FILTER_NONE_VALUE, label: "No value" },
      { value: propertyValueToken("high"), label: "High" },
      { value: propertyValueToken("low"), label: "Low" },
    ]);
  });

  it("groups unset values separately and orders that group last", () => {
    const groups = groupWorkItemsByProperty(
      items,
      definition,
      indexScopePropertyValues(values),
      [{ id: "alice", name: "Alice" }]
    );
    expect(groups.map((group) => group.label)).toEqual([
      "Alice, bob",
      "No value",
    ]);
    expect(groups[1].items.map((item) => item.shortId)).toEqual([
      "WI-2",
      "WI-3",
    ]);
  });

  it("sorts typed values semantically and always places missing values last", () => {
    const numberDefinition: PropertyDefinition = {
      ...definition,
      id: "estimate",
      propertyType: "number",
      name: "Estimate",
    };
    expect(
      [10, null, 2].sort((left, right) =>
        comparePropertyValues(numberDefinition, left, right, new Map())
      )
    ).toEqual([2, 10, null]);

    expect(
      comparePropertyValues(
        definition,
        ["member:bob"],
        ["member:alice"],
        new Map([
          ["alice", "Alice"],
          ["bob", "Bob"],
        ])
      )
    ).toBeGreaterThan(0);
  });
});
