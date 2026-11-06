/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as lib_auth from "../lib/auth.js";
import type * as lib_ledger from "../lib/ledger.js";
import type * as lib_review from "../lib/review.js";
import type * as me from "../me.js";
import type * as messages from "../messages.js";
import type * as push from "../push.js";
import type * as rituals from "../rituals.js";
import type * as rooms from "../rooms.js";
import type * as runner from "../runner.js";
import type * as runners from "../runners.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "lib/auth": typeof lib_auth;
  "lib/ledger": typeof lib_ledger;
  "lib/review": typeof lib_review;
  me: typeof me;
  messages: typeof messages;
  push: typeof push;
  rituals: typeof rituals;
  rooms: typeof rooms;
  runner: typeof runner;
  runners: typeof runners;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
