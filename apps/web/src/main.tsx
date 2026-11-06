import "@fontsource-variable/inter";
import "./index.css";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ClerkShell } from "./auth/ClerkShell";
import { routeTree } from "./routeTree.gen";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const applyAppearance = () =>
  document.documentElement.classList.toggle("dark", darkQuery.matches);
applyAppearance();
darkQuery.addEventListener("change", applyAppearance);

createRoot(document.querySelector("#root") as HTMLElement).render(
  <StrictMode>
    <ClerkShell>
      <RouterProvider router={router} />
    </ClerkShell>
  </StrictMode>
);
