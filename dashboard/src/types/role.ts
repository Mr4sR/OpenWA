// Role types for RBAC
export type UserRole = 'admin' | 'operator' | 'viewer';

export interface RoleContextType {
  role: UserRole | null;
  setRole: (role: UserRole | null) => void;
  isAdmin: boolean;
  isOperator: boolean;
  isViewer: boolean;
  canWrite: boolean;
  /** Engine the gateway runs, as POST /auth/validate reported it; null until it has answered. */
  engineType: string | null;
  setEngineType: (engineType: string | null) => void;
  /** Whether the key is restricted (selected sessions or one account), so cross-session routes refuse it. */
  scoped: boolean;
  setScoped: (scoped: boolean) => void;
  /** The account (tenant) the key acts for; null when the key is global (every account). */
  accountId: string | null;
  setAccountId: (accountId: string | null) => void;
}
