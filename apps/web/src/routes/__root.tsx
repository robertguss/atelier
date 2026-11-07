import { Link, Outlet, createRootRoute } from "@tanstack/react-router";

import { MessagePage } from "~/components/page";
import { Button } from "~/components/ui/button";

export const Route = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <MessagePage
      title="Page not found"
      description="This address doesn't match anything in Atelier."
    >
      <Button variant="outline" render={<Link to="/" />}>
        Your rooms
      </Button>
    </MessagePage>
  ),
});
