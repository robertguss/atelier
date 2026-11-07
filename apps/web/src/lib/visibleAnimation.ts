// Copied from T3 Code (https://github.com/pingdotgg/t3code), apps/web/src/lib/visibleAnimation.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

interface ObservedAnimation {
  element: HTMLElement | SVGElement;
  intersecting: boolean;
}

const animations = new Map<Element, ObservedAnimation>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;

const updateAnimation = (animation: ObservedAnimation) => {
  const running =
    animation.intersecting &&
    document.visibilityState === "visible" &&
    reducedMotion?.matches !== true;
  animation.element.style.setProperty(
    "--visible-animation-state",
    running ? "running" : "paused"
  );
  animation.element.style.setProperty(
    "--visible-animation-will-change",
    running ? "transform" : "auto"
  );
};

const updateAnimations = () => {
  for (const animation of animations.values()) {
    updateAnimation(animation);
  }
};

export const observeVisibleAnimation = (
  element: HTMLElement | SVGElement | null
): (() => void) | undefined => {
  if (element === null) {
    return undefined;
  }
  element.style.setProperty("--visible-animation-state", "paused");
  element.style.setProperty("--visible-animation-will-change", "auto");
  if (typeof IntersectionObserver === "undefined") {
    return undefined;
  }

  if (observer === null) {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.addEventListener("change", updateAnimations);
    document.addEventListener("visibilitychange", updateAnimations);
    observer = new IntersectionObserver((entries, source) => {
      if (source !== observer) {
        return;
      }
      for (const entry of entries) {
        const animation = animations.get(entry.target);
        if (!animation) {
          continue;
        }
        animation.intersecting = entry.isIntersecting;
        updateAnimation(animation);
      }
    });
  }

  const animation = { element, intersecting: false };
  animations.set(element, animation);
  observer.observe(element);

  return () => {
    if (animations.get(element) !== animation) {
      return;
    }
    animations.delete(element);
    observer?.unobserve(element);
    element.style.setProperty("--visible-animation-state", "paused");
    element.style.setProperty("--visible-animation-will-change", "auto");
    if (animations.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotion?.removeEventListener("change", updateAnimations);
      reducedMotion = null;
      document.removeEventListener("visibilitychange", updateAnimations);
    }
  };
};
