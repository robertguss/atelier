import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StreamingMarkdown } from "./StreamingMarkdown";

// The finished text, parsed whole, as the reference for every streamed step.
const finished = (text: string) =>
  render(<StreamingMarkdown text={text} />).container.innerHTML.replace(
    ' data-streaming=""',
    ""
  );

const streamed = (steps: readonly string[]) => {
  const view = render(<StreamingMarkdown text="" streaming />);
  return steps.map((text) => {
    view.rerender(<StreamingMarkdown text={text} streaming />);
    return view.container.innerHTML.replace(' data-streaming=""', "");
  });
};

describe("streaming markdown", () => {
  it("renders text that grows past a closed code fence exactly as the finished text", () => {
    // The footnote mark ties the blocks together, so the text is parsed whole as it grows.
    const steps = [
      "Intro[^1] to the fix.\n\n```ts\nconst a = 1;\n```\n\n",
      "Intro[^1] to the fix.\n\n```ts\nconst a = 1;\n```\n\nThen **bold**",
      "Intro[^1] to the fix.\n\n```ts\nconst a = 1;\n```\n\nThen **bold** and\n\n```\nb\n```\n\nend",
    ];
    expect(streamed(steps)).toStrictEqual(steps.map(finished));
  });

  it("resolves a link whose definition arrives after a closed code fence", () => {
    // The footnote mark keeps the text whole while it streams.
    const start = "See [the docs][d], note[^1].\n\n```\nx\n```\n\nMore";
    const end = `${start}\n\n[d]: https://example.com/docs`;
    const [before, after] = streamed([start, end]);
    expect([before, after]).toStrictEqual([finished(start), finished(end)]);
    expect(after).toContain('href="https://example.com/docs"');
  });
});
