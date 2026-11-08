import { useState, useEffect, useCallback, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazyWithRetry as lazy } from './utils/lazyWithRetry';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { useRole } from './hooks/useRole';
import { RoleProvider } from './components/RoleProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { saasAuthApi, type SaasUser } from './services/api';
import { canManageDeployment, clearActorState, isPlatformAdmin, readStoredSessionUser, uiRoleFor } from './utils/authLifecycle';
import './App.css';

const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Sessions = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const Chats = lazy(() => import('./pages/Chats').then(m => ({ default: m.Chats })));
const Webhooks = lazy(() => import('./pages/Webhooks').then(m => ({ default: m.Webhooks })));
const Templates = lazy(() => import('./pages/Templates').then(m => ({ default: m.Templates })));
const Logs = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));
const ApiKeys = lazy(() => import('./pages/ApiKeys').then(m => ({ default: m.ApiKeys })));
const MessageTester = lazy(() => import('./pages/MessageTester').then(m => ({ default: m.MessageTester })));
const NumberChecker = lazy(() => import('./pages/NumberChecker').then(m => ({ default: m.NumberChecker })));
const Infrastructure = lazy(() => import('./pages/Infrastructure').then(m => ({ default: m.Infrastructure })));
const Plugins = lazy(() => import('./pages/Plugins'));
const AiIntegration = lazy(() => import('./pages/AiIntegration').then(m => ({ default: m.AiIntegration })));
const Accounts = lazy(() => import('./pages/Accounts').then(m => ({ default: m.Accounts })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const Platform = lazy(() => import('./pages/Platform').then(m => ({ default: m.Platform })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

function AppContent() {
  // Capture the token ONCE at mount: it only decides whether the initial screen is the login form.
  // The login page stores it before calling handleLogin, so reading it live per render would flip
  // this on every sign-in without changing anything else.
  const [savedToken] = useState(() => sessionStorage.getItem('openwa_saas_token'));
  const [isAuthenticated, setIsAuthenticated] = useState(!!savedToken);
  const { setRole, role, setEngineType, setScoped, scoped, setAccountId, accountId } = useRole();
  // The signed-in SaaS user, kept in state (seeded from the stored one) so the gates below follow a
  // sign-in without a reload — the earlier version read sessionStorage once at mount, which froze the
  // platform surface to whoever held the tab before the login.
  const [sessionUser, setSessionUser] = useState<SaasUser | null>(() => readStoredSessionUser<SaasUser>());

  /** Apply one sign-in's identity everywhere the UI gates on: the role context and the platform surface. */
  const applyActor = useCallback(
    (user: SaasUser | null) => {
      setSessionUser(user);
      setRole(user ? uiRoleFor(user) : null);
      setAccountId(user?.accountId ?? null);
      // A SaaS session token is never session-allowlisted: the tenant keeps every create affordance.
      setScoped(false);
    },
    [setRole, setAccountId, setScoped],
  );

  // /accounts, /auth/api-keys, /infra and /plugins are @RequireRole(ADMIN) + @RequireUnscopedKey: the
  // guard admits only an ADMIN principal with no session allowlist and no account. A tenant admin is
  // ADMIN inside its own account, so those pages would only 403 there. Layout filters its nav with
  // this same predicate, so a menu entry can never outlive the route it points at.
  const canManageDeploymentPages = canManageDeployment(role, scoped, accountId);
  // /platform is the developer surface: the server admits only a platform_admin login.
  const platformAccess = isPlatformAdmin(sessionUser);

  const handleLogin = (token: string, user: SaasUser) => {
    sessionStorage.setItem('openwa_saas_token', token);
    sessionStorage.setItem('openwa_saas_user', JSON.stringify(user));
    // The login answer already carries the role; an absent or unrecognized role falls back to the
    // least-privileged default (viewer) in uiRoleFor().
    applyActor(user);
    setIsAuthenticated(true);
  };

  const handleLogout = useCallback(() => {
    setIsAuthenticated(false);
    applyActor(null);
    setEngineType(null);
    sessionStorage.removeItem('openwa_api_key');
    sessionStorage.removeItem('openwa_saas_token');
    sessionStorage.removeItem('openwa_saas_user');
    // Wipe the React Query cache too: it is keyed by resource, not actor, so without a full
    // clear a logout → login in the same tab with a different key/scope shows the previous
    // actor's sessions/messages/apiKeys/audit rows.
    clearActorState(queryClient);
  }, [applyActor, setEngineType]);

  // Re-validate the SaaS session on mount: /auth/me re-derives role/account from the LIVE user row
  // (a disabled user or suspended tenant is logged out here), so a stale cached role never outlives
  // the server's answer. The cached user already seeded the role in RoleProvider, so the first paint
  // gates correctly instead of flashing a role-less UI.
  useEffect(() => {
    if (!savedToken) return;
    if (!sessionStorage.getItem('openwa_saas_user')) return;
    saasAuthApi
      .me(savedToken)
      .then(profile => {
        if (sessionStorage.getItem('openwa_saas_token') !== savedToken) return;
        sessionStorage.setItem('openwa_saas_user', JSON.stringify(profile.user));
        applyActor(profile.user);
      })
      .catch(() => {
        // Invalid/expired token or a suspended tenant: the truth says sign in again.
        if (sessionStorage.getItem('openwa_saas_token') === savedToken) handleLogout();
      });
  }, [savedToken, applyActor, handleLogout]);

  const loadingFallback = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <Loader2 className="animate-spin" size={32} />
    </div>
  );

  if (!isAuthenticated) {
    return (
      <Suspense fallback={loadingFallback}>
        <Login onLogin={handleLogin} />
      </Suspense>
    );
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={loadingFallback}>
          <Routes>
            <Route path="/" element={<Layout onLogout={handleLogout} canViewPlatform={platformAccess} />}>
              <Route index element={<Dashboard />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="chats" element={<Chats />} />
              <Route path="number-checker" element={<NumberChecker />} />
              <Route path="settings" element={<Settings />} />
              {platformAccess && <Route path="platform" element={<Platform />} />}
              <Route path="webhooks" element={<Webhooks />} />
              <Route path="templates" element={<Templates />} />
              {canManageDeploymentPages && <Route path="accounts" element={<Accounts />} />}
              {canManageDeploymentPages && <Route path="api-keys" element={<ApiKeys />} />}
              {role === 'admin' && <Route path="logs" element={<Logs />} />}
              <Route path="message-tester" element={<MessageTester />} />
              {canManageDeploymentPages && <Route path="infrastructure" element={<Infrastructure />} />}
              {canManageDeploymentPages && <Route path="plugins" element={<Plugins />} />}
              {/* Tenant admins configure their own AI surfaces; the API scopes every row by account.
                  Members reach no AI route, so the page stays admin-only for them. */}
              {role === 'admin' && <Route path="ai-integration" element={<AiIntegration />} />}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RoleProvider>
          <AppContent />
        </RoleProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
