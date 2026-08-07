interface WordSegment {
  isWordLike?: boolean;
}

interface WordSegmenter {
  segment: (input: string) => Iterable<WordSegment>;
}

type WordSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "word" }
) => WordSegmenter;

const Segmenter = (
  Intl as typeof Intl & { Segmenter?: WordSegmenterConstructor }
).Segmenter;

const wordSegmenter = Segmenter
  ? new Segmenter(undefined, { granularity: "word" })
  : null;

export const countWords = (value: string): number => {
  const normalized = value.trim();
  if (!normalized) return 0;

  if (wordSegmenter) {
    return Array.from(wordSegmenter.segment(normalized)).filter(
      (segment) => segment.isWordLike
    ).length;
  }

  return normalized.split(/\s+/u).length;
};
