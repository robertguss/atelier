import { assert, describe, expect, it } from "vitest";

import { renderedRange, selectionIn, sourceRange } from "./selection";

// What the reader selected, as the browser reports it, and the rendered
// text before it in the block.
const select = (source: string, selected: string, before: string) => {
  const range = sourceRange(source, selected, before);
  return range && { ...range, passage: source.slice(range.start, range.end) };
};

describe("mapping a selection to the stored text", () => {
  it("maps a selection in plain text to the same offsets", () => {
    expect(select("Charge per seat.", "per seat", "Charge ")).toStrictEqual({
      end: 15,
      passage: "per seat",
      start: 7,
    });
  });

  it("maps a selection that crosses markdown emphasis to the offsets of the source", () => {
    const source = "Charge **per seat** and _never_ per `call`.";
    expect(select(source, "rge per", "Cha")).toStrictEqual({
      end: 12,
      passage: "rge **per",
      start: 3,
    });
    expect(
      select(source, "seat and never per call", "Charge per ")
    ).toStrictEqual({
      end: 41,
      passage: "seat** and _never_ per `call",
      start: 13,
    });
  });

  it("maps link text and leaves out the hidden link target", () => {
    const source = "See [the pricing page](https://example.com/pricing) first.";
    expect(select(source, "pricing page first", "See the ")?.passage).toBe(
      "pricing page](https://example.com/pricing) first"
    );
    expect(select(source, "the pricing", "See ")?.passage).toBe("the pricing");
  });

  it("ignores line breaks the browser renders differently", () => {
    const source = "Options:\nPer seat\nPer call";
    expect(select(source, "Per seat Per call", "Options: ")?.passage).toBe(
      "Per seat\nPer call"
    );
  });

  it("keeps a list marker written in a block's text, which shows as text", () => {
    expect(select("1. Per seat\n- Per call", "1. Per seat", "")?.passage).toBe(
      "1. Per seat"
    );
    expect(
      select("1. Per seat\n+ Per call", "+ Per call", "1. Per seat ")?.passage
    ).toBe("+ Per call");
  });

  it("maps a to-do or numbered item from its text alone, its box and number drawn outside it", () => {
    expect(select("Email **Dana**", "Email Dana", "")).toStrictEqual({
      end: 12,
      passage: "Email **Dana",
      start: 0,
    });
    expect(select("Ship v1 by Friday", "v1", "Ship ")).toStrictEqual({
      end: 7,
      passage: "v1",
      start: 5,
    });
  });

  it("keeps underscores and asterisks that are part of the visible text", () => {
    expect(
      select("Rename user_id to owner", "user_id", "Rename ")?.passage
    ).toBe("user_id");
  });

  it("prefers the occurrence nearest to where the selection sits", () => {
    const source = "seat, then *seat*, then seat";
    expect(select(source, "seat", "")).toMatchObject({ end: 4, start: 0 });
    expect(select(source, "seat", "seat, then ")).toMatchObject({
      end: 16,
      start: 12,
    });
    expect(select(source, "seat", "seat, then seat, then ")).toMatchObject({
      end: 28,
      start: 24,
    });
  });

  it("finds nothing for a selection of only spaces or syntax, or text the block does not hold", () => {
    expect(sourceRange("Charge per seat.", "  ", "Charge")).toBeNull();
    expect(sourceRange("Charge per seat.", "per call", "Charge ")).toBeNull();
  });
});

// The text node at the start of the first `selector` match in `container`.
const textOf = (container: Element, selector: string) => {
  const node = container.querySelector(selector)?.firstChild;
  assert(node);
  return node;
};

const currentSelection = () => {
  const selection = document.getSelection();
  assert(selection);
  return selection;
};

const rendered = (html: string) => {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return container;
};

describe("reading the selection from the page", () => {
  it("reports the selected text and the text before it, within the block", () => {
    const container = rendered("<p>Charge <strong>per seat</strong> now.</p>");
    const plain = textOf(container, "p");
    const strong = textOf(container, "strong");
    const range = document.createRange();
    range.setStart(plain, 3);
    range.setEnd(strong, 3);
    const selection = currentSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    expect(selectionIn(container, selection)).toStrictEqual({
      before: "Cha",
      selected: "rge per",
    });
    container.remove();
  });

  it("reports nothing when the selection is collapsed or reaches outside the block", () => {
    const container = rendered("<p>Charge per seat.</p>");
    const outside = rendered("<p>Elsewhere</p>");
    const selection = currentSelection();
    const range = document.createRange();
    range.setStart(textOf(container, "p"), 2);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selectionIn(container, selection)).toBeNull();

    range.setEnd(textOf(outside, "p"), 3);
    expect(selectionIn(container, selection)).toBeNull();
    container.remove();
    outside.remove();
  });
});

describe("finding a stored passage on the page", () => {
  it("returns the range of rendered text that shows a passage of the source", () => {
    const container = rendered(
      "<p>Charge <strong>per seat</strong> and <em>never</em> per call.</p>"
    );
    const source = "Charge **per seat** and _never_ per call.";
    const start = source.indexOf("seat");
    expect(
      renderedRange(
        container,
        source,
        start,
        source.indexOf("never") + 5
      )?.toString()
    ).toBe("seat and never");
    container.remove();
  });

  it("returns nothing for a passage that is not shown", () => {
    const container = rendered("<p>Something else entirely</p>");
    expect(renderedRange(container, "Charge per seat.", 0, 6)).toBeNull();
    container.remove();
  });
});
