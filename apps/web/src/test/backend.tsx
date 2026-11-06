// Test doubles for the two module boundaries the screens read from:
// convex/react (queries, mutations, auth state) and the Clerk shell.
// Each test file mocks those modules with `convexMock` and `authMock` below
// and sets `backend` to the state it needs.

import { getFunctionName } from 'convex/server';
import { vi } from 'vitest';

type QueryHandler = (args: Record<string, unknown>) => unknown;

export const backend = {
  signedIn: true,
  queries: {} as Record<string, QueryHandler>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
};

export const signOut = vi.fn(async () => {});

export function resetBackend() {
  backend.signedIn = true;
  backend.queries = {};
  backend.mutations = {};
  signOut.mockClear();
}

export const convexMock = {
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: backend.signedIn }),
  // Like Convex, a skipped query returns undefined and never runs; a query
  // the test did not set up stays loading. A handler that throws behaves like
  // a server error reaching the component.
  useQuery: (ref: never, args?: Record<string, unknown> | 'skip') => {
    if (args === 'skip') return undefined;
    const handler = backend.queries[getFunctionName(ref)];
    return handler ? handler(args ?? {}) : undefined;
  },
  useMutation: (ref: never) => {
    const name = getFunctionName(ref);
    backend.mutations[name] ??= vi.fn(async () => null);
    return backend.mutations[name];
  },
};

export const authMock = {
  SignInPanel: () => <div>Clerk sign-in form</div>,
  useSignedInEmail: () => (backend.signedIn ? 'sam@other.example' : null),
  useSignOut: () => signOut,
};
