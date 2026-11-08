import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// The jsdom suites slow down when every workspace tests at once, and the
// first `findBy` in a file timed out at the 1 s default then.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});

const doNothing = (): void => {
  // Stands in for a browser feature jsdom lacks.
};

// jsdom has no scrolling; the router's scroll restoration calls this.
window.scrollTo = doNothing;

const fakeMediaQueryList = (query: string): MediaQueryList => {
  const list = {
    addEventListener: doNothing,
    addListener: doNothing,
    dispatchEvent: () => false,
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: doNothing,
    removeListener: doNothing,
  };
  return list;
};

// jsdom has no media queries or resize observers. Screens see a wide window.
window.matchMedia ??= fakeMediaQueryList;

globalThis.ResizeObserver ??= class {
  disconnect = doNothing;
  observe = doNothing;
  unobserve = doNothing;
};

// jsdom does no layout; ProseMirror measures text ranges to scroll the caret into view.
Object.assign(Range.prototype, {
  getBoundingClientRect: () => new DOMRect(),
  getClientRects: () => document.body.getClientRects(),
});
