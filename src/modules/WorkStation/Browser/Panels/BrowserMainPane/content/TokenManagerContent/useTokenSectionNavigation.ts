import { useCallback, useEffect, useRef, useState } from "react";

import type { TokenCategory } from "@src/modules/WorkStation/Browser/hooks/useGlobalTokens";

import { toggleCollapsedTokenSection } from "./model";

export function useTokenSectionNavigation(
  categories: readonly TokenCategory[],
  enabled: boolean
) {
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    new Set()
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const handleAnchorSelect = useCallback((key: string) => {
    setActiveCategory(key);
    sectionRefs.current
      .get(key)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const setSectionRef = useCallback(
    (key: string) => (element: HTMLDivElement | null) => {
      if (element) sectionRefs.current.set(key, element);
      else sectionRefs.current.delete(key);
    },
    []
  );
  const toggleSection = useCallback((sectionName: string) => {
    setCollapsedSections((current) =>
      toggleCollapsedTokenSection(current, sectionName)
    );
  }, []);
  const collapseAll = useCallback(
    () => setCollapsedSections(new Set(categories.map((item) => item.name))),
    [categories]
  );
  const expandAll = useCallback(() => setCollapsedSections(new Set()), []);

  useEffect(() => {
    const container = contentRef.current;
    if (!container || !enabled) return;
    const handleScroll = () => {
      const containerTop = container.getBoundingClientRect().top;
      let currentSection: string | null = null;
      let minDistance = Infinity;
      for (const [name, element] of sectionRefs.current.entries()) {
        const rect = element.getBoundingClientRect();
        const distance = Math.abs(rect.top - containerTop);
        if (rect.top <= containerTop + 50 && distance < minDistance) {
          minDistance = distance;
          currentSection = name;
        }
      }
      if (currentSection) setActiveCategory(currentSection);
    };
    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [enabled]);

  return {
    activeCategory,
    collapsedSections,
    contentRef,
    handleAnchorSelect,
    setSectionRef,
    toggleSection,
    collapseAll,
    expandAll,
  };
}
