// Test doubles for the two module boundaries the screens read from:
// convex/react (queries, mutations, actions, auth state) and the Clerk shell.
// Each test file mocks those modules with `convexMock` and `authMock` below
// and sets `backend` to the state it needs. After changing `backend` while a
// screen is shown, call `pushBackend()` to re-run its queries, as a live
// Convex subscription would.

import { getFunctionName } from 'convex/server';
import { useSyncExternalStore } from 'react';
import { vi } from 'vitest';

type QueryHandler = (args: Record<string, unknown>) => unknown;

export const backend = {
  signedIn: true,
  queries: {} as Record<string, QueryHandler>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  actions: {} as Record<string, ReturnType<typeof vi.fn>>,
};

export const signOut = vi.fn(async () => {});

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function pushBackend() {
  version++;
  for (const listener of listeners) listener();
}

export function resetBackend() {
  backend.signedIn = true;
  backend.queries = {};
  backend.mutations = {};
  backend.actions = {};
  signOut.mockClear();
}

function runQuery(ref: never, args?: Record<string, unknown> | 'skip') {
  if (args === 'skip') return undefined;
  const handler = backend.queries[getFunctionName(ref)];
  return handler ? handler(args ?? {}) : undefined;
}

export const convexMock = {
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: backend.signedIn }),
  // Like Convex, a skipped query returns undefined and never runs; a query
  // the test did not set up stays loading. A handler that throws behaves like
  // a server error reaching the component.
  useQuery: (ref: never, args?: Record<string, unknown> | 'skip') => {
    useSyncExternalStore(subscribe, () => version);
    return runQuery(ref, args);
  },
  useMutation: (ref: never) => {
    const name = getFunctionName(ref);
    backend.mutations[name] ??= vi.fn(async () => null);
    return backend.mutations[name];
  },
  useAction: (ref: never) => {
    const name = getFunctionName(ref);
    backend.actions[name] ??= vi.fn(async () => null);
    return backend.actions[name];
  },
  // One-off reads, as `useConvex().query(...)` does.
  useConvex: () => ({ query: async (ref: never, args?: Record<string, unknown>) => runQuery(ref, args) }),
};

export const authMock = {
  SignInPanel: () => <div>Clerk sign-in form</div>,
  useSignedInEmail: () => (backend.signedIn ? 'sam@other.example' : null),
  useSignOut: () => signOut,
};
