// Auth-lifecycle helpers: logout cleanup and startup re-validation decisions.

import type { UserRole } from '../types/role';

const USER_ROLES: readonly UserRole[] = ['admin', 'operator', 'viewer'];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** What the dashboard needs of a SaaS user; `SaasUser` satisfies it. */
export interface SessionUserLike {
  role?: string;
  accountId?: string | null;
}

/**
 * The dashboard role of a SaaS login, mirroring SaasPrincipalService.resolve() on the server:
 * the platform operator and a tenant admin are ADMIN (inside their own account), a member is
 * OPERATOR, anything else VIEWER. One function so every site that maps a user cannot drift.
 */
export function uiRoleFor(user: SessionUserLike | null | undefined): UserRole {
  if (user?.role === 'platform_admin' || user?.role === 'account_admin') return 'admin';
  return user?.role === 'account_member' ? 'operator' : 'viewer';
}

/** The stored SaaS login, or null when there is none (or it does not parse). */
export function readStoredSessionUser<T extends SessionUserLike>(): T | null {
  const raw = sessionStorage.getItem('openwa_saas_user');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** True for the developer surface, which the server admits only to a platform_admin login. */
export function isPlatformAdmin(user: SessionUserLike | null | undefined): boolean {
  return user?.role === 'platform_admin';
}

/**
 * True when the actor reaches the deployment-global pages (`/accounts`, `/api-keys`,
 * `/infrastructure`, `/plugins`). Those routes are ADMIN-only AND @RequireUnscopedKey on the server,
 * which the guard enforces as role ADMIN + no session allowlist + no accountId — a tenant admin is
 * ADMIN inside its own account, so a menu entry for it would only 403. The nav and the routes both
 * use this one predicate, so a link is never offered for a page that cannot load. `/platform` is
 * narrower still and uses isPlatformAdmin().
 */
export function canManageDeployment(
  role: UserRole | null,
  scoped: boolean,
  accountId: string | null,
): boolean {
  return role === 'admin' && !scoped && accountId === null;
}

/** Structural cache surface (a TanStack QueryClient satisfies this) so tests can use a stub. */
export interface ClearableCache {
  clear(): void;
}

/**
 * Drop every piece of actor-scoped cached state on logout. The React Query cache is keyed by
 * resource, not by actor — without a full clear, logout → login in the same tab with a
 * different key/scope renders the previous actor's sessions/messages/apiKeys/audit rows.
 */
export function clearActorState(...caches: ClearableCache[]): void {
  for (const cache of caches) cache.clear();
}

/**
 * Captures the stored API key now and returns a check that holds only while it is still the stored
 * one. Logout cancels nothing in flight, so a download started before it must not save its file once
 * the key is gone or another sign-in's has replaced it.
 */
export function keepsSameKey(): () => boolean {
  const key = sessionStorage.getItem('openwa_api_key');
  return () => sessionStorage.getItem('openwa_api_key') === key;
}

const IP_REFUSALS: ReadonlySet<string> = new Set(['IP address not allowed', 'Client IP could not be determined']);

/**
 * True when a response proves the stored key cannot be used from this client, so the dashboard must
 * log out: a 401, or a 403 because the key's allowedIps refuse this client (the IP can change
 * mid-session). A role or scope 403 leaves the key usable for other requests.
 */
export function isKeyUnusable(status: number, message: unknown): boolean {
  return status === 401 || (status === 403 && typeof message === 'string' && IP_REFUSALS.has(message));
}

export type StartupValidation =
  | { action: 'role'; role: UserRole; scoped: boolean; engineType?: string; accountId: string | null }
  | { action: 'logout' }
  | { action: 'keep' };

/**
 * Fold the startup /auth/validate answer into an auth decision (full rationale at the type):
 * 401/403 → logout; transient failures → keep; ok + role → refresh the cached role, scope,
 * account and engine. A network throw never reaches this function.
 */
export function resolveStartupValidation(
  status: number,
  body: { valid?: boolean; role?: string; engineType?: string; scoped?: unknown; accountId?: unknown } | null,
): StartupValidation {
  if (status === 401 || status === 403) return { action: 'logout' };
  if (status < 200 || status >= 300) return { action: 'keep' };
  if (body?.valid && isUserRole(body.role)) {
    const scoped = body.scoped === true;
    // A missing/odd accountId is the global surface, never an error: the key simply acts globally.
    const accountId = typeof body.accountId === 'string' && body.accountId.length > 0 ? body.accountId : null;
    return typeof body.engineType === 'string'
      ? { action: 'role', role: body.role, scoped, engineType: body.engineType, accountId }
      : { action: 'role', role: body.role, scoped, accountId };
  }
  return { action: 'keep' };
}
