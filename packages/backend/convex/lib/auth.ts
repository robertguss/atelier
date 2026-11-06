import type { QueryCtx } from '../_generated/server';

// Atelier has one human. ATELIER_OWNER_EMAILS (comma-separated) lists the
// Clerk accounts allowed in; everyone else is treated as signed out.
export async function getOwner(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const raw: string = process.env.ATELIER_OWNER_EMAILS ?? '';
  const allowed = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const email = identity.email?.toLowerCase();
  if (!email || !allowed.includes(email)) return null;
  return identity;
}

export async function requireOwner(ctx: QueryCtx) {
  const owner = await getOwner(ctx);
  if (!owner) throw new Error('Not signed in as the Atelier owner');
  return owner;
}

// Runner functions authenticate with a shared secret instead of Clerk.
export function requireRunnerSecret(secret: string) {
  const expected = process.env.ATELIER_RUNNER_SECRET;
  if (!expected || !timingSafeEqual(secret, expected)) {
    throw new Error('Bad runner secret');
  }
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
