// Copied from T3 Code (https://github.com/pingdotgg/t3code), apps/web/src/markdown-incremental.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import type { Root, RootContent } from "mdast";
import type { Parser as UnifiedParser, Plugin } from "unified";

type Parser = UnifiedParser<Root>;

// unified types a processor's parser as returning any syntax tree.
type SyntaxTree = ReturnType<UnifiedParser>;

const isRoot = (node: SyntaxTree): node is Root => node.type === "root";

interface ParsedPrefix {
  source: string;
  offset: number;
  line: number;
  children: RootContent[];
}

const hasDefinitions = (node: Root | RootContent): boolean =>
  node.type === "definition" ||
  node.type === "footnoteDefinition" ||
  ("children" in node && node.children.some((child) => hasDefinitions(child)));

const shiftPositions = (
  node: Root | RootContent,
  offset: number,
  lines: number
): void => {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) {
        point.offset += offset;
      }
      point.line += lines;
    }
  }
  if ("children" in node) {
    for (const child of node.children) {
      shiftPositions(child, offset, lines);
    }
  }
};

// The cache entry ending after the last complete fence that a blank line follows, if any.
const cacheAfterLastFence = (
  root: Root,
  source: string,
  prefix: ParsedPrefix | undefined
): ParsedPrefix | undefined => {
  for (let index = root.children.length - 1; index >= 0; index -= 1) {
    const node = root.children[index];
    if (node?.type !== "code") {
      continue;
    }
    const { position } = node;
    const start = position?.start.offset;
    const end = position?.end.offset;
    if (position === undefined || start === undefined || end === undefined) {
      continue;
    }
    if (prefix !== undefined && end < prefix.offset) {
      return undefined;
    }
    const value = source.slice(start, end);
    const opening = /^ {0,3}(?<fence>`{3,}|~{3,})[^\n]*\n/u.exec(value)?.groups
      ?.fence;
    if (opening === undefined) {
      continue;
    }
    const lastLine = value.slice(value.lastIndexOf("\n") + 1);
    const closing = new RegExp(
      `^ {0,3}${opening.charAt(0)}{${opening.length},}[ \\t]*$`,
      "u"
    );
    const separator = /^\n[ \t]*\n/u.exec(source.slice(end))?.[0];
    if (!closing.test(lastLine) || separator === undefined) {
      continue;
    }
    const offset = end + separator.length;
    return {
      children: structuredClone(root.children.slice(0, index + 1)),
      line: position.end.line + 2,
      offset,
      source: source.slice(0, offset),
    };
  }
  return undefined;
};

// Cache completed fences followed by blank lines; document-wide definitions require a full parse.
const createIncrementalMarkdownParser = (parse: Parser): Parser => {
  let cached: ParsedPrefix | undefined;

  return (source, file) => {
    // Streaming CR may become CRLF; parsing a suffix separately would strip an internal BOM.
    if (source.includes("\r") || source.includes("﻿")) {
      return parse(source, file);
    }

    const prefix =
      cached !== undefined && source.startsWith(cached.source)
        ? cached
        : undefined;
    let root: Root;
    if (prefix === undefined) {
      root = parse(source, file);
      if (hasDefinitions(root)) {
        return root;
      }
    } else {
      root = parse(source.slice(prefix.offset), file);
      if (hasDefinitions(root)) {
        return parse(source, file);
      }
      shiftPositions(root, prefix.offset, prefix.line - 1);
      if (root.position) {
        root.position.start = { column: 1, line: 1, offset: 0 };
      }
      // Remark mutates nodes; give each render a clone of the pristine cache.
      root.children.unshift(...structuredClone(prefix.children));
    }

    cached = cacheAfterLastFence(root, source, prefix) ?? cached;
    return root;
  };
};

/** Use one cache per streaming renderer; extra syntax plugins require the normal parser. */
export const createIncrementalMarkdownPlugin = (): Plugin<[], Root> => {
  let parser: Parser | undefined;
  return function incrementalMarkdownPlugin() {
    const original = this.parser;
    if (!original) {
      return;
    }
    parser ??= createIncrementalMarkdownParser((source, file) => {
      const tree = original(source, file);
      if (!isRoot(tree)) {
        throw new TypeError("The Markdown parser did not return a root node");
      }
      return tree;
    });
    const parseDocument = parser;
    // ReactMarkdown parses recovery text second; only the first parse may access the document cache.
    let documentParsed = false;
    this.parser = (source, file) => {
      if (documentParsed) {
        return original(source, file);
      }
      documentParsed = true;
      return parseDocument(source, file);
    };
  };
};
