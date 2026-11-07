// Comment anchors. A thread remembers its passage as a W3C TextQuoteSelector
// (the exact text, with up to 32 characters before and after it) plus the
// passage's start in the block's text. Offsets are JavaScript string indices
// into the block's stored text. When the text changes, `matchQuote` finds the
// passage again, following Hypothesis's approach: every candidate match is
// scored on how closely it matches the quote, its prefix and suffix, and how
// near it lies to the old position.

export interface Selector {
  exact: string;
  prefix: string;
  suffix: string;
  position: number;
}
export interface Match {
  start: number;
  end: number;
  score: number;
}

export const CONTEXT_CHARS = 32;

const QUOTE_WEIGHT = 50;
const PREFIX_WEIGHT = 20;
const SUFFIX_WEIGHT = 20;
const POSITION_WEIGHT = 2;
const MAX_SCORE =
  QUOTE_WEIGHT + PREFIX_WEIGHT + SUFFIX_WEIGHT + POSITION_WEIGHT;

// Below this, the passage counts as gone. The quote alone, found exactly,
// scores above it whatever happened around it; a loose match needs about half
// of its surrounding text to have survived as well.
export const MIN_SCORE = 0.5;

export const selectorAt = (
  text: string,
  start: number,
  end: number
): Selector => ({
  exact: text.slice(start, end),
  position: start,
  prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
  suffix: text.slice(end, end + CONTEXT_CHARS),
});

interface Candidate {
  start: number;
  end: number;
  errors: number;
}

// Approximate substring search: an edit-distance table where the match may
// start anywhere in the text, one column per text character. Each cell keeps
// the start of its best alignment, so every end position yields a match; of
// the matches that share a start, the one with fewest edits is kept.
const approximate = (
  text: string,
  quote: string,
  maxErrors: number
): Candidate[] => {
  const m = quote.length;
  let cost = Array.from({ length: m + 1 }, (_, i) => i);
  let from = Array.from({ length: m + 1 }, () => 0);
  const byStart = new Map<number, Candidate>();
  for (let j = 1; j <= text.length; j += 1) {
    const nextCost = [0];
    const nextFrom = [j];
    for (let i = 1; i <= m; i += 1) {
      const substitute =
        (cost[i - 1] ?? 0) + (quote[i - 1] === text[j - 1] ? 0 : 1);
      const skipText = (cost[i] ?? 0) + 1;
      const skipQuote = (nextCost[i - 1] ?? 0) + 1;
      if (substitute <= skipText && substitute <= skipQuote) {
        nextCost.push(substitute);
        nextFrom.push(from[i - 1] ?? 0);
      } else if (skipText <= skipQuote) {
        nextCost.push(skipText);
        nextFrom.push(from[i] ?? 0);
      } else {
        nextCost.push(skipQuote);
        nextFrom.push(nextFrom[i - 1] ?? 0);
      }
    }
    cost = nextCost;
    from = nextFrom;
    const errors = cost[m] ?? 0;
    const start = from[m] ?? 0;
    if (
      errors <= maxErrors &&
      errors < (byStart.get(start)?.errors ?? Infinity)
    ) {
      byStart.set(start, { end: j, errors, start });
    }
  }
  return [...byStart.values()];
};

// Every exact occurrence of `quote`, or, when there is none, every place it
// occurs with at most `maxErrors` edits.
const search = (
  text: string,
  quote: string,
  maxErrors: number
): Candidate[] => {
  const exact: Candidate[] = [];
  for (
    let at = text.indexOf(quote);
    at !== -1;
    at = text.indexOf(quote, at + 1)
  ) {
    exact.push({ end: at + quote.length, errors: 0, start: at });
  }
  return exact.length > 0 ? exact : approximate(text, quote, maxErrors);
};

// How closely `context` appears in `window`, from 0 to 1.
const contextScore = (window: string, context: string) => {
  if (context.length === 0) {
    return 1;
  }
  if (window.length === 0) {
    return 0;
  }
  const best = Math.min(
    ...search(window, context, context.length).map((c) => c.errors)
  );
  return 1 - best / context.length;
};

// The best place for the selector's passage in `text`, or null when the
// passage is gone.
export const matchQuote = (text: string, selector: Selector): Match | null => {
  const { exact, prefix, suffix, position } = selector;
  if (exact.length === 0) {
    return null;
  }
  const maxErrors = Math.min(256, Math.floor(exact.length / 2));
  let best: Match | null = null;
  for (const c of search(text, exact, maxErrors)) {
    const quoteScore = 1 - c.errors / exact.length;
    const prefixScore = contextScore(
      text.slice(Math.max(0, c.start - prefix.length), c.start),
      prefix
    );
    const suffixScore = contextScore(
      text.slice(c.end, c.end + suffix.length),
      suffix
    );
    const positionScore =
      text.length === 0 ? 1 : 1 - Math.abs(c.start - position) / text.length;
    const score =
      (QUOTE_WEIGHT * quoteScore +
        PREFIX_WEIGHT * prefixScore +
        SUFFIX_WEIGHT * suffixScore +
        POSITION_WEIGHT * positionScore) /
      MAX_SCORE;
    if (!best || score > best.score) {
      best = { end: c.end, score, start: c.start };
    }
  }
  return best && best.score >= MIN_SCORE ? best : null;
};
