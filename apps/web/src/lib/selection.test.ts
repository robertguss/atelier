import { describe, expect, it } from 'vitest';
import { renderedRange, selectionIn, sourceRange } from './selection';

// What the reader selected, as the browser reports it, and the rendered
// text before it in the block.
function select(source: string, selected: string, before: string) {
  const range = sourceRange(source, selected, before);
  return range && { ...range, passage: source.slice(range.start, range.end) };
}

describe('mapping a selection to the stored text', () => {
  it('maps a selection in plain text to the same offsets', () => {
    expect(select('Charge per seat.', 'per seat', 'Charge ')).toEqual({ start: 7, end: 15, passage: 'per seat' });
  });

  it('maps a selection that crosses markdown emphasis to the offsets of the source', () => {
    const source = 'Charge **per seat** and _never_ per `call`.';
    expect(select(source, 'rge per', 'Cha')).toEqual({ start: 3, end: 12, passage: 'rge **per' });
    expect(select(source, 'seat and never per call', 'Charge per ')).toEqual({ start: 13, end: 41, passage: 'seat** and _never_ per `call' });
  });

  it('maps link text and leaves out the hidden link target', () => {
    const source = 'See [the pricing page](https://example.com/pricing) first.';
    expect(select(source, 'pricing page first', 'See the ')?.passage).toBe('pricing page](https://example.com/pricing) first');
    expect(select(source, 'the pricing', 'See ')?.passage).toBe('the pricing');
  });

  it('ignores line breaks and list markers the browser renders differently', () => {
    const source = 'Options:\n\n1. Per seat\n2. Per call';
    expect(select(source, 'Per seat\nPer call', 'Options:')?.passage).toBe('Per seat\n2. Per call');
  });

  it('keeps underscores and asterisks that are part of the visible text', () => {
    expect(select('Rename user_id to owner', 'user_id', 'Rename ')?.passage).toBe('user_id');
  });

  it('prefers the occurrence nearest to where the selection sits', () => {
    const source = 'seat, then *seat*, then seat';
    expect(select(source, 'seat', '')).toMatchObject({ start: 0, end: 4 });
    expect(select(source, 'seat', 'seat, then ')).toMatchObject({ start: 12, end: 16 });
    expect(select(source, 'seat', 'seat, then seat, then ')).toMatchObject({ start: 24, end: 28 });
  });

  it('finds nothing for a selection of only spaces or syntax, or text the block does not hold', () => {
    expect(sourceRange('Charge per seat.', '  ', 'Charge')).toBeNull();
    expect(sourceRange('Charge per seat.', 'per call', 'Charge ')).toBeNull();
  });
});

function rendered(html: string) {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

describe('reading the selection from the page', () => {
  it('reports the selected text and the text before it, within the block', () => {
    const container = rendered('<p>Charge <strong>per seat</strong> now.</p>');
    const [plain, strong] = [container.querySelector('p')!.firstChild!, container.querySelector('strong')!.firstChild!];
    const range = document.createRange();
    range.setStart(plain, 3);
    range.setEnd(strong, 3);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(selectionIn(container, selection)).toEqual({ selected: 'rge per', before: 'Cha' });
    container.remove();
  });

  it('reports nothing when the selection is collapsed or reaches outside the block', () => {
    const container = rendered('<p>Charge per seat.</p>');
    const outside = rendered('<p>Elsewhere</p>');
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(container.querySelector('p')!.firstChild!, 2);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selectionIn(container, selection)).toBeNull();

    range.setEnd(outside.querySelector('p')!.firstChild!, 3);
    expect(selectionIn(container, selection)).toBeNull();
    container.remove();
    outside.remove();
  });
});

describe('finding a stored passage on the page', () => {
  it('returns the range of rendered text that shows a passage of the source', () => {
    const container = rendered('<p>Charge <strong>per seat</strong> and <em>never</em> per call.</p>');
    const source = 'Charge **per seat** and _never_ per call.';
    const start = source.indexOf('seat');
    expect(renderedRange(container, source, start, source.indexOf('never') + 5)?.toString()).toBe('seat and never');
    container.remove();
  });

  it('returns nothing for a passage that is not shown', () => {
    const container = rendered('<p>Something else entirely</p>');
    expect(renderedRange(container, 'Charge per seat.', 0, 6)).toBeNull();
    container.remove();
  });
});
