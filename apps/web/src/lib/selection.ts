// Comments are anchored to offsets in a block's stored text, which is
// markdown, while the reader selects rendered text. The two are matched on
// the characters a reader sees: whitespace and markdown syntax characters are
// left out of both sides, link targets and list markers out of the source,
// and the selected characters are looked for in the source near where the
// selection sits in the rendered block.

// Characters left out on both sides. Some of them can be visible text too,
// such as the underscore in user_id; dropping them everywhere keeps such text
// matching all the same.
const IGNORED = /[\s*_~`#>|<[\]\\-]/u;

// A list marker at the start of a line, which the browser draws without text.
const LIST_MARKER = /[ \t]*(?:\d{1,9}[.)]|[-+*])[ \t]+/uy;

/** The characters a reader sees, each with its index in the text it came from. */
interface Projection {
  chars: string;
  at: number[];
}

const projectText = (text: string): Projection => {
  let chars = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (IGNORED.test(text.charAt(i))) {
      continue;
    }
    chars += text[i];
    at.push(i);
  }
  return { at, chars };
};

// The index of the `)` that closes the link target opened at `open`.
const linkTargetEnd = (source: string, open: number) => {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "(") {
      depth += 1;
    } else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    } else if (source[i] === "\n") {
      return i - 1;
    }
  }
  return source.length;
};

const projectMarkdown = (source: string): Projection => {
  let chars = "";
  const at: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (i === 0 || source[i - 1] === "\n") {
      LIST_MARKER.lastIndex = i;
      if (LIST_MARKER.test(source)) {
        i = LIST_MARKER.lastIndex;
      }
      if (i >= source.length) {
        break;
      }
    }
    if (source[i] === "]" && source[i + 1] === "(") {
      i = linkTargetEnd(source, i + 1);
      continue;
    }
    if (IGNORED.test(source.charAt(i))) {
      continue;
    }
    chars += source[i];
    at.push(i);
  }
  return { at, chars };
};

// The occurrence of `needle` in `haystack` that starts nearest `hint`.
const nearest = (haystack: string, needle: string, hint: number) => {
  let best = -1;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + 1)
  ) {
    if (best === -1 || Math.abs(at - hint) < Math.abs(best - hint)) {
      best = at;
    }
  }
  return best;
};

/**
 * The passage [start, end) of the stored `source` that shows as `selected`,
 * where `before` is the rendered text of the block ahead of the selection.
 * Null when the selection shows nothing of the source.
 */
export const sourceRange = (
  source: string,
  selected: string,
  before: string
): { start: number; end: number } | null => {
  const needle = projectText(selected).chars;
  if (!needle) {
    return null;
  }
  const projected = projectMarkdown(source);
  const found = nearest(
    projected.chars,
    needle,
    projectText(before).chars.length
  );
  if (found === -1) {
    return null;
  }
  const start = projected.at[found];
  const last = projected.at[found + needle.length - 1];
  if (start === undefined || last === undefined) {
    return null;
  }
  return { end: last + 1, start };
};

/** The selected text in `container` and the container's text before it, when the selection lies wholly inside it. */
export const selectionIn = (
  container: Node,
  selection: Selection | null
): { selected: string; before: string } | null => {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return null;
  }
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  return { before: before.toString(), selected: range.toString() };
};

/** The rendered text in `container` that shows the passage [start, end) of its stored `source`, if it is shown. */
export const renderedRange = (
  container: Node,
  source: string,
  start: number,
  end: number
): Range | null => {
  const projected = projectMarkdown(source);
  const first = projected.at.findIndex((i) => i >= start);
  const last = projected.at.findLastIndex((i) => i < end);
  if (first === -1 || last < first) {
    return null;
  }

  const points: { node: Text; offset: number }[] = [];
  let chars = "";
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) {
      continue;
    }
    const text = node.data;
    for (let offset = 0; offset < text.length; offset += 1) {
      if (IGNORED.test(text.charAt(offset))) {
        continue;
      }
      chars += text.charAt(offset);
      points.push({ node, offset });
    }
  }
  const needle = projected.chars.slice(first, last + 1);
  const found = nearest(chars, needle, first);
  if (found === -1) {
    return null;
  }
  const from = points[found];
  const to = points[found + needle.length - 1];
  if (from === undefined || to === undefined) {
    return null;
  }
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset + 1);
  return range;
};
