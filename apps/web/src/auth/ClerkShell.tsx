// The only module that imports Clerk. Everything else reads auth through
// convex/react (useConvexAuth) or the helpers exported here, so a desktop
// wrapper can later swap the sign-in mechanism in one place.
//
// The appearance variables are adapted from T3 Code's clerkAppearance.ts
// (https://github.com/pingdotgg/t3code). Copyright (c) 2026 T3 Tools Inc.
// MIT License; see THIRD_PARTY_NOTICES.md.

import { api } from '@atelier/backend/api';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { ConvexReactClient, useConvexAuth, useMutation } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Spinner } from '~/components/ui/spinner';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? '';
const convexUrl = import.meta.env.VITE_CONVEX_URL ?? '';

const appearance = {
  // index.css orders this layer below components and utilities.
  cssLayerName: 'clerk',
  variables: {
    borderRadius: '0.5rem',
    colorPrimary: 'var(--primary)',
    colorPrimaryForeground: 'var(--primary-foreground)',
    colorDanger: 'var(--error)',
    colorSuccess: 'var(--success)',
    colorWarning: 'var(--warning)',
    colorNeutral: 'var(--contrast-foreground)',
    colorForeground: 'var(--contrast-foreground)',
    colorMutedForeground: 'var(--contrast-muted-foreground)',
    colorBackground: 'var(--card)',
    colorInputForeground: 'var(--contrast-foreground)',
    colorInput: 'var(--secondary)',
    colorRing: 'var(--ring)',
  },
};

let convex: ConvexReactClient | null = null;

export function ClerkShell({ children }: { children: ReactNode }) {
  if (!publishableKey || !convexUrl) {
    throw new Error('Set VITE_CLERK_PUBLISHABLE_KEY and VITE_CONVEX_URL in apps/web/.env.local');
  }
  convex ??= new ConvexReactClient(convexUrl);
  return (
    <ClerkProvider publishableKey={publishableKey} appearance={appearance}>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <EnsureUser>{children}</EnsureUser>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

// Creates or refreshes the caller's user row once per sign-in, before any
// signed-in screen queries rooms, so a new account never flashes "no access".
function EnsureUser({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  const ensure = useMutation(api.users.ensure);
  const [ensured, setEnsured] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) {
      started.current = false;
      setEnsured(false);
      return;
    }
    if (started.current) return;
    started.current = true;
    ensure()
      .catch((error: unknown) => console.error('users.ensure failed', error))
      .finally(() => setEnsured(true));
  }, [isAuthenticated, ensure]);

  if (isAuthenticated && !ensured) return <FullPageSpinner />;
  return <>{children}</>;
}

function FullPageSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size="lg" tone="muted" />
    </div>
  );
}

// The signed-in person's primary email, or null while signed out.
export function useSignedInEmail(): string | null {
  const { user } = useUser();
  return user?.primaryEmailAddress?.emailAddress ?? null;
}

// Signs out and comes back to the current page, signed out.
export function useSignOut(): () => Promise<void> {
  const clerk = useClerk();
  return () => clerk.signOut({ redirectUrl: window.location.pathname });
}

// Clerk's own sign-in or sign-up form, embedded in the page with hash routing
// and redirect-based OAuth (no popups). A Clerk invitation link arrives with
// `__clerk_ticket` and `__clerk_status` query params; the form reads the
// ticket itself, so an invited address can sign up while sign-up is restricted.
export function SignInPanel() {
  const params = new URLSearchParams(window.location.search);
  const ticket = params.get('__clerk_ticket');
  const status = params.get('__clerk_status');
  const returnTo = window.location.pathname;
  if (ticket && (status === 'sign_up' || status === null)) {
    return <SignUp routing="hash" oauthFlow="redirect" forceRedirectUrl={returnTo} signInForceRedirectUrl={returnTo} />;
  }
  return <SignIn routing="hash" oauthFlow="redirect" forceRedirectUrl={returnTo} signUpForceRedirectUrl={returnTo} />;
}
