import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { routeTree } from '~/routeTree.gen';

// Renders the real route tree at `path`, so route params and navigation are exercised.
export function renderAt(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  return { router, ...render(<RouterProvider router={router} />) };
}
