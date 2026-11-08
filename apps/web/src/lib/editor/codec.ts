import type { BlockKind } from "@atelier/shared";
import type { JSONContent } from "@tiptap/core";
import { Lexer } from "marked";
import type { Token } from "marked";

/** Every kind but the divider, which holds no text and gets no editor. */
export type TextKind = Exclude<BlockKind, "divider">;

// The code kind's node cannot be called "code": inline code is the mark of that name.
export const nodeName = (kind: TextKind) =>
  kind === "code" ? "codeBlock" : kind;

// A stretch of text with the same formatting. Marks are keys in a fixed
// order (outermost first), a link as `link:<href>`; a hard break is "\n".
interface Run {
  text: string;
  marks: string[];
}

const MARK_ORDER = ["link", "bold", "italic", "strike", "code"];
const DELIMITER: Record<string, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
};

const markType = (key: string) => key.split(":", 1)[0] ?? key;
const byOrder = (a: string, b: string) =>
  MARK_ORDER.indexOf(markType(a)) - MARK_ORDER.indexOf(markType(b));
const merge = (runs: Run[]): Run[] => {
  const merged: Run[] = [];
  for (const run of runs) {
    const last = merged.at(-1);
    const marks = run.marks.toSorted(byOrder);
    if (last && last.marks.join(" ") === marks.join(" ")) {
      last.text += run.text;
    } else if (run.text) {
      merged.push({ marks, text: run.text });
    }
  }
  return merged;
};

const runsFromTokens = (tokens: Token[], marks: string[]): Run[] =>
  tokens.flatMap((token): Run[] => {
    const within = (mark: string) =>
      runsFromTokens("tokens" in token ? (token.tokens ?? []) : [], [
        ...marks,
        mark,
      ]);
    switch (token.type) {
      case "strong": {
        return within("bold");
      }
      case "em": {
        return within("italic");
      }
      case "del": {
        return within("strike");
      }
      case "link": {
        return within(`link:${String(token.href)}`);
      }
      case "codespan": {
        return [{ marks: [...marks, "code"], text: String(token.text) }];
      }
      case "br": {
        return [{ marks, text: "\n" }];
      }
      case "escape":
      case "text": {
        return [{ marks, text: String(token.text) }];
      }
      default: {
        // Images, inline HTML and anything else this schema lacks stay literal text.
        return [{ marks, text: token.raw }];
      }
    }
  });

// Inline markdown only: block markers such as `# ` or `- ` at the start are plain text.
const parseRuns = (text: string) =>
  merge(runsFromTokens(Lexer.lexInline(text, { breaks: true, gfm: true }), []));

const markJson = (key: string) =>
  markType(key) === "link"
    ? { attrs: { href: key.slice("link:".length) }, type: "link" }
    : { type: key };

const inlineJson = (runs: Run[]): JSONContent[] =>
  runs.flatMap((run) => {
    const marks = run.marks.length ? { marks: run.marks.map(markJson) } : {};
    return run.text
      .split("\n")
      .flatMap((text, i): JSONContent[] => [
        ...(i > 0 ? [{ type: "hardBreak", ...marks }] : []),
        ...(text ? [{ text, type: "text", ...marks }] : []),
      ]);
  });

/** The editor document for a block: one node of the block's kind. */
export const toDoc = (kind: TextKind, text: string): JSONContent => {
  // Code is literal: no markdown, and "\n" stays in the text.
  const plain = text ? [{ text, type: "text" }] : [];
  const content = kind === "code" ? plain : inlineJson(parseRuns(text));
  return {
    content: [{ type: nodeName(kind), ...(content.length ? { content } : {}) }],
    type: "doc",
  };
};

const markKey = (mark: JSONContent) =>
  mark.type === "link" ? `link:${String(mark.attrs?.href)}` : String(mark.type);

const runsOf = (content: readonly JSONContent[]): Run[] =>
  merge(
    content.map((node) => ({
      marks: (node.marks ?? []).map(markKey),
      text: node.type === "hardBreak" ? "\n" : (node.text ?? ""),
    }))
  );

const EMPHASIS = new Set(["bold", "italic", "strike"]);

// Delimiters next to whitespace are not markup, so whitespace at the edge of
// an emphasised run moves out to the formatting its neighbour shares.
const shedWhitespace = (runs: Run[]): Run[] =>
  merge(
    runs.flatMap((run, i) => {
      if (run.marks.includes("code")) {
        return [run];
      }
      const outer = (...others: (Run | undefined)[]) =>
        run.marks.filter(
          (m) =>
            !EMPHASIS.has(m) ||
            others.every((o) => o?.marks.includes(m) === true)
        );
      const lead = /^\s*/u.exec(run.text)?.[0] ?? "";
      const body = run.text.trim();
      if (!body) {
        return [{ marks: outer(runs[i - 1], runs[i + 1]), text: run.text }];
      }
      const trail = run.text.slice(lead.length + body.length);
      return [
        { marks: outer(runs[i - 1]), text: lead },
        { marks: run.marks, text: body },
        { marks: outer(runs[i + 1]), text: trail },
      ];
    })
  );

const isBareUrl = (run: Run) => {
  const [mark, ...rest] = run.marks;
  const href =
    mark?.startsWith("link:") === true ? mark.slice("link:".length) : null;
  return (
    rest.length === 0 &&
    (href === run.text || href === `http://${run.text}`) &&
    /^(?:https?:\/\/|www\.)\S+$/u.test(run.text)
  );
};

const codeSpan = (text: string) => {
  const longest = Math.max(
    0,
    ...(text.match(/`+/gu) ?? []).map((s) => s.length)
  );
  const fence = "`".repeat(longest + 1);
  const pad = /^[`\s]|[`\s]$/u.test(text) && text.trim() ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
};

const opening = (key: string) =>
  markType(key) === "link" ? "[" : (DELIMITER[key] ?? "");

const closing = (key: string) => {
  if (markType(key) !== "link") {
    return DELIMITER[key] ?? "";
  }
  const href = key.slice("link:".length);
  return /[\s()]/u.test(href) ? `](<${href}>)` : `](${href})`;
};

const serialize = (runs: Run[], escape: (text: string) => string) => {
  let out = "";
  const open: string[] = [];
  const closeTo = (depth: number) => {
    while (open.length > depth) {
      out += closing(open.pop() ?? "");
    }
  };
  for (const run of runs) {
    const bare = isBareUrl(run);
    const marks = bare ? [] : run.marks.filter((m) => m !== "code");
    let keep = 0;
    while (keep < open.length && open[keep] === marks[keep]) {
      keep += 1;
    }
    closeTo(keep);
    for (const mark of marks.slice(keep)) {
      out += opening(mark);
      open.push(mark);
    }
    if (bare) {
      out += run.text;
    } else if (run.marks.includes("code")) {
      out += codeSpan(run.text);
    } else {
      out += escape(run.text);
    }
  }
  closeTo(0);
  return out;
};

// Escapes only characters that could open or close markup where they stand:
// a lone `*` between spaces or the `_` inside snake_case stays as written.
const escapeMarkup = (text: string) =>
  text
    .replaceAll(/\\(?=[!-/:-@[-`{-~])/gu, String.raw`\\`)
    .replaceAll(/[`[\]]/gu, String.raw`\$&`)
    .replaceAll(/(?<=\S)[*~]|[*~](?=\S)/gu, String.raw`\$&`)
    .replaceAll(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, String.raw`\_`);

/** A block's stored text from its editor document. */
export const fromDoc = (doc: JSONContent): string => {
  const node = doc.content?.[0];
  if (node?.type === nodeName("code")) {
    return (node.content ?? []).map((n) => n.text ?? "").join("");
  }
  const runs = shedWhitespace(runsOf(node?.content ?? []));
  // Text as written, unless that reads back differently; then escaped.
  const plain = serialize(runs, (text) => text);
  const readsBack = JSON.stringify(parseRuns(plain)) === JSON.stringify(runs);
  return readsBack ? plain : serialize(runs, escapeMarkup);
};
