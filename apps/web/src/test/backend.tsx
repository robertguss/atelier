// Test doubles for the two module boundaries the screens read from:
// convex/react (queries, mutations, actions, auth state) and the Clerk shell.
// Each test file mocks those modules with `convexMock` and `authMock` below
// and sets `backend` to the state it needs. After changing `backend` while a
// screen is shown, call `pushBackend()` to re-run its queries, as a live
// Convex subscription would. A paginated query's handler gets
// `paginationOpts` and returns `{ page, isDone, continueCursor }`, as the
// Convex function does; `paginate` builds such a handler from a list.

import { getFunctionName } from 'convex/server';
import { useState, useSyncExternalStore } from 'react';
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

type PageResult = { page: unknown[]; isDone: boolean; continueCursor: string };
type PaginationOpts = { numItems: number; cursor: string | null };

/** A paginated query handler over `items`, in the order given. */
export function paginate(items: () => readonly unknown[]) {
  return ({ paginationOpts }: Record<string, unknown>): PageResult => {
    const { numItems, cursor } = paginationOpts as PaginationOpts;
    const start = cursor ? Number(cursor) : 0;
    const end = start + numItems;
    const all = items();
    return { page: all.slice(start, end), isDone: end >= all.length, continueCursor: String(end) };
  };
}

const LOADING_FIRST_PAGE = { results: [], status: 'LoadingFirstPage', isLoading: true, loadMore: () => {} } as const;

export const convexMock = {
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: backend.signedIn }),
  // Like Convex, a skipped query returns undefined and never runs; a query
  // the test did not set up stays loading. A handler that throws behaves like
  // a server error reaching the component.
  useQuery: (ref: never, args?: Record<string, unknown> | 'skip') => {
    useSyncExternalStore(subscribe, () => version);
    return runQuery(ref, args);
  },
  // Loads the first page, then one more page per `loadMore`, each from the
  // cursor the previous page returned.
  usePaginatedQuery: (ref: never, args: Record<string, unknown> | 'skip', options: { initialNumItems: number }) => {
    useSyncExternalStore(subscribe, () => version);
    const [sizes, setSizes] = useState<number[]>([options.initialNumItems]);
    const handler = args === 'skip' ? undefined : backend.queries[getFunctionName(ref)];
    if (!handler || args === 'skip') return LOADING_FIRST_PAGE;
    const results: unknown[] = [];
    let cursor: string | null = null;
    let isDone = false;
    for (const numItems of sizes) {
      const result = handler({ ...args, paginationOpts: { numItems, cursor } }) as PageResult;
      results.push(...result.page);
      cursor = result.continueCursor;
      isDone = result.isDone;
      if (isDone) break;
    }
    return {
      results,
      status: isDone ? 'Exhausted' : 'CanLoadMore',
      isLoading: false,
      loadMore: (numItems: number) => setSizes((current) => [...current, numItems]),
    };
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
  useConvex: () => ({ query: async (ref: never, args?: Record<string, unknown>) => runQuery(ref, args) }),
};

export const authMock = {
  SignInPanel: () => <div>Clerk sign-in form</div>,
  useSignedInEmail: () => (backend.signedIn ? 'sam@other.example' : null),
  useSignOut: () => signOut,
};
