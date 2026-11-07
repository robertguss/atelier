import { api } from '@atelier/backend/api';
import { Link } from '@tanstack/react-router';
import { useConvexAuth, useQuery } from 'convex/react';
import type { ReactNode } from 'react';
import { SignInPanel } from '~/auth/ClerkShell';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { StandalonePage, StandalonePageHeader } from '~/components/ui/standalone-page';

export function PageSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size="lg" tone="muted" />
    </div>
  );
}

export function MessagePage({ title, description, children }: { title: ReactNode; description: ReactNode; children?: ReactNode }) {
  return (
    <StandalonePage>
      <StandalonePageHeader title={title} description={description} />
      {children ? <div className="mt-6 flex flex-wrap gap-2">{children}</div> : null}
    </StandalonePage>
  );
}

export function SignInScreen({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">{title}</h1>
        {description ? <p className="mt-2 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <SignInPanel />
    </div>
  );
}

export function SignedInOnly({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) return <PageSpinner />;
  if (!isAuthenticated) return <SignInScreen title="Sign in to Atelier" />;
  return <>{children}</>;
}

// For pages only the owner may use. Everyone else sees `title` and a way back.
export function OwnerOnly({ title, children }: { title: string; children: ReactNode }) {
  const me = useQuery(api.me.get, {});
  if (me === undefined) return <PageSpinner />;
  if (!me.signedIn || !me.isOwner) {
    return (
      <MessagePage title={title} description="This page is for the room owner.">
        <Button variant="outline" render={<Link to="/" />}>
          Your rooms
        </Button>
      </MessagePage>
    );
  }
  return <>{children}</>;
}
