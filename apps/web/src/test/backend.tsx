// Test doubles for the two module boundaries the screens read from:
// convex/react (queries, mutations, actions, auth state) and the Clerk shell.
// Each test file mocks those modules with `convexMock` and `authMock` below
// and sets `backend` to the state it needs. After changing `backend` while a
// screen is shown, call `pushBackend()` to re-run its queries, as a live
// Convex subscription would.

import type * as ConvexReact from "convex/react";
import { getFunctionName } from "convex/server";
import type {
  FunctionReference,
  FunctionReference_future,
} from "convex/server";
import { useSyncExternalStore } from "react";
import { vi } from "vitest";
import type { Mock } from "vitest";

import type * as ClerkShell from "~/auth/ClerkShell";

type QueryHandler = (args: Record<string, unknown>) => unknown;
type FunctionHandler = (args?: Record<string, unknown>) => Promise<unknown>;
type FunctionMock = Mock<FunctionHandler>;

export const backend: {
  actions: Record<string, FunctionMock>;
  mutations: Record<string, FunctionMock>;
  queries: Record<string, QueryHandler>;
  signedIn: boolean;
} = {
  actions: {},
  mutations: {},
  queries: {},
  signedIn: true,
};

export const signOut = vi.fn<() => Promise<void>>().mockResolvedValue();

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const pushBackend = () => {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
};

export const resetBackend = () => {
  backend.signedIn = true;
  backend.queries = {};
  backend.mutations = {};
  backend.actions = {};
  signOut.mockClear();
};

const functionMock = (
  registry: Record<string, FunctionMock>,
  name: string
): FunctionMock => {
  registry[name] ??= vi.fn<FunctionHandler>().mockResolvedValue(null);
  return registry[name];
};

/** The mock behind a mutation, by function name. Until a test sets it up it resolves to null. */
export const mutation = (name: string) => functionMock(backend.mutations, name);

/** The mock behind an action, by function name. Until a test sets it up it resolves to null. */
export const action = (name: string) => functionMock(backend.actions, name);

const runQuery = (
  ref: FunctionReference<"query"> | FunctionReference_future<"query">,
  args: Record<string, unknown> | "skip" | undefined
): unknown => {
  if (args === "skip") {
    return undefined;
  }
  const handler = backend.queries[getFunctionName(ref)];
  return handler ? handler(args ?? {}) : undefined;
};

// The registries hold whatever each test set up, keyed by function name, so
// the hook stand-ins can only claim the result type the real hook declares.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters, typescript/no-unsafe-type-assertion -- Registries keyed by function name cannot carry each Convex function's result type; this is the one place the stand-ins claim it.
const asHookResult = <Result,>(value: unknown): Result => value as Result;

// Like Convex, a skipped query returns undefined and never runs; a query the
// test did not set up stays loading. A handler that throws behaves like a
// server error reaching the component.
const useQuery: typeof ConvexReact.useQuery = (query, ...args) => {
  useSyncExternalStore(subscribe, () => version);
  return asHookResult(runQuery(query, args[0]));
};

const useMutation: typeof ConvexReact.useMutation = (reference) =>
  asHookResult(mutation(getFunctionName(reference)));

const useAction: typeof ConvexReact.useAction = (reference) =>
  asHookResult(action(getFunctionName(reference)));

export const convexMock: Partial<typeof ConvexReact> = {
  useAction,
  useConvexAuth: () => ({
    isAuthenticated: backend.signedIn,
    isLoading: false,
    isRefreshing: false,
  }),
  useMutation,
  useQuery,
};

export const authMock: Partial<typeof ClerkShell> = {
  SignInPanel: () => <div>Clerk sign-in form</div>,
  useSignOut: () => signOut,
  useSignedInEmail: () => (backend.signedIn ? "sam@other.example" : null),
};
