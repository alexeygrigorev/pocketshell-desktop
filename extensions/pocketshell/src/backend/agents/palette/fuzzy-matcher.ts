/**
 * Fuzzy matcher for the slash-command palette.
 *
 * Pure character-by-character fuzzy matching with scoring.
 * Score boosts for prefix matches, word boundary matches,
 * contiguous runs, and exact matches.
 */

/** Result of a successful fuzzy match. */
export interface FuzzyMatchResult {
  /** Match score (higher = better). */
  score: number;

  /** Matched character ranges for UI highlighting. */
  highlights: [number, number][];
}

// Score constants
const SCORE_CHARACTER = 1;
const SCORE_WORD_BOUNDARY = 5;
const SCORE_CONTIGUOUS = 2; // bonus per consecutive matched char beyond the first
const SCORE_PREFIX_BONUS = 15; // flat bonus when match starts at text[0]
const SCORE_EXACT_BONUS = 50; // flat bonus for exact equality

/**
 * Perform a fuzzy match of `query` against `text`.
 *
 * Returns a result with score and highlight ranges if every character
 * in `query` can be found (in order) within `text`. Returns `null`
 * if no match is possible.
 *
 * Matching is case-insensitive.
 */
export function fuzzyMatch(
  query: string,
  text: string,
): FuzzyMatchResult | null {
  if (query.length === 0) {
    // Empty query matches everything with neutral score
    return { score: 1, highlights: [] };
  }

  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  // Exact match check
  if (queryLower === textLower) {
    return {
      score: SCORE_EXACT_BONUS + text.length * SCORE_CHARACTER,
      highlights: [[0, text.length]],
    };
  }

  // Walk through text, consuming query characters in order
  let queryIdx = 0;
  let score = 0;
  const highlights: [number, number][] = [];
  let rangeStart = -1;
  let contiguousCount = 0;
  let startedAtPrefix = false;

  for (
    let textIdx = 0;
    textIdx < text.length && queryIdx < query.length;
    textIdx++
  ) {
    if (textLower[textIdx] === queryLower[queryIdx]) {
      // Start a new highlight range if not already in one
      if (rangeStart === -1) {
        rangeStart = textIdx;
      }

      // Score based on position
      if (textIdx === 0 && queryIdx === 0) {
        // First char matches first char — base character score
        score += SCORE_CHARACTER;
        startedAtPrefix = true;
      } else if (isWordBoundary(text, textIdx)) {
        score += SCORE_WORD_BOUNDARY;
      } else {
        score += SCORE_CHARACTER;
      }

      // Track contiguous matches
      contiguousCount++;
      if (contiguousCount > 1) {
        score += SCORE_CONTIGUOUS;
      }

      queryIdx++;
    } else {
      // Character didn't match — close current highlight range if any
      if (rangeStart !== -1) {
        highlights.push([rangeStart, textIdx]);
        rangeStart = -1;
      }
      // Reset contiguous counter
      contiguousCount = 0;
    }
  }

  // Close final highlight range
  if (rangeStart !== -1) {
    highlights.push([rangeStart, text.length]);
  }

  // If we didn't consume all query characters, it's not a match
  if (queryIdx !== query.length) {
    return null;
  }

  // Apply flat prefix bonus if the match started at the beginning of text
  if (startedAtPrefix) {
    score += SCORE_PREFIX_BONUS;
  }

  return { score, highlights };
}

/**
 * Check if the character at `index` in `text` is at a word boundary.
 * A word boundary is the start of the string, or the previous character
 * is a space, slash, hyphen, or underscore.
 */
function isWordBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  return prev === ' ' || prev === '/' || prev === '-' || prev === '_';
}
