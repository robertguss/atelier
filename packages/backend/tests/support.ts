import type { TestConvex } from "convex-test";
import { assert, expect } from "vitest";

import type schema from "../convex/schema";

// The value, narrowed from null and undefined, or a failed assertion naming
// what was missing. For results a test has already established exist.
export const defined = <V>(value: V | null | undefined, what = "value"): V => {
  assert(value !== null && value !== undefined, `${what} is defined`);
  return value;
};

// A signed-in caller from `t.withIdentity`, or the test client itself.
export type Caller = ReturnType<TestConvex<typeof schema>["withIdentity"]>;

// Asymmetric matchers, typed so they can sit inside an expected object.
export const stringContaining = (text: string): unknown =>
  expect.stringContaining(text);
export const stringMatching = (pattern: RegExp): unknown =>
  expect.stringMatching(pattern);
export const closeTo = (value: number, digits: number): unknown =>
  expect.closeTo(value, digits);

// How each call is refused, in order: the error message, or "resolved" for a
// call that went through. The calls run one after another.
export const rejectionsOf = async (calls: (() => Promise<unknown>)[]) => {
  const outcomes: string[] = [];
  for (const call of calls) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each call may change what the next one sees
      await call();
      outcomes.push("resolved");
    } catch (error) {
      assert(error instanceof Error, "the call rejected with an Error");
      outcomes.push(error.message);
    }
  }
  return outcomes;
};
