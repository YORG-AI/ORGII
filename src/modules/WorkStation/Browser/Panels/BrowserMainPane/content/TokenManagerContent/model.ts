import type {
  TokenCategory,
  TokenDefinition,
} from "@src/modules/WorkStation/Browser/hooks/useGlobalTokens";

export function findTokenCategory(
  categories: readonly TokenCategory[],
  category: string
): TokenCategory | undefined {
  const normalizedCategory = category.toLowerCase();
  return categories.find(
    (item) => item.name.toLowerCase() === normalizedCategory
  );
}

export function filterTokenCategories(
  categories: readonly TokenCategory[],
  searchQuery: string
): TokenCategory[] {
  const query = searchQuery.toLowerCase().trim();
  if (!query) return [...categories];
  return categories
    .map((category) => ({
      ...category,
      tokens: category.tokens.filter(
        (token) =>
          token.name.toLowerCase().includes(query) ||
          token.value.toLowerCase().includes(query)
      ),
    }))
    .filter((category) => category.tokens.length > 0);
}

export function countCategoryTokens(
  categories: readonly TokenCategory[]
): number {
  return categories.reduce((sum, category) => sum + category.tokens.length, 0);
}

export function areAllTokenSectionsCollapsed(
  categories: readonly TokenCategory[],
  collapsedSections: ReadonlySet<string>
): boolean {
  return (
    categories.length > 0 &&
    categories.every((category) => collapsedSections.has(category.name))
  );
}

export function toggleCollapsedTokenSection(
  collapsedSections: ReadonlySet<string>,
  sectionName: string
): Set<string> {
  const next = new Set(collapsedSections);
  if (next.has(sectionName)) next.delete(sectionName);
  else next.add(sectionName);
  return next;
}

export function getTokenColorStyle(
  token: Pick<TokenDefinition, "value">
): { backgroundColor: string } | undefined {
  const { value } = token;
  if (value.startsWith("#") || value.startsWith("rgb")) {
    return { backgroundColor: value };
  }
  if (/^\d+,\s*\d+,\s*\d+/.test(value)) {
    return { backgroundColor: `rgb(${value})` };
  }
  return undefined;
}
