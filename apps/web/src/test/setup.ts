import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

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
