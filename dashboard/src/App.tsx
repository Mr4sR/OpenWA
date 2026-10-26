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
import { clearActorState, isUserRole } from './utils/authLifecycle';
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
  // Capture the key ONCE at mount. Read live per render, the null→key transition when
  // handleLogin stores a fresh key would re-fire the startup re-validation effect below and
  // double the /auth/validate request on every sign-in — the effect is for genuine page
  // refreshes with a saved key only.
  // SaaS session token (email+password login). The API key is picked on the post-login step and
  // rides separately; the token identifies the USER, the key authorizes the WIRE.
  const [savedToken] = useState(() => sessionStorage.getItem('openwa_saas_token'));
  const [isAuthenticated, setIsAuthenticated] = useState(!!savedToken);
  const { setRole, role, setEngineType, setScoped, setAccountId } = useRole();
  // Read once: the platform route is developer-only, and the server refuses it regardless.
  const [isPlatformAdmin] = useState(() => {
    try {
      const raw = sessionStorage.getItem('openwa_saas_user');
      return raw ? (JSON.parse(raw) as { role?: string }).role === 'platform_admin' : false;
    } catch {
      return false;
    }
  });

  const handleLogin = (token: string, user: SaasUser) => {
    sessionStorage.setItem('openwa_saas_token', token);
    sessionStorage.setItem('openwa_saas_user', JSON.stringify(user));

    // The login page's validate response already carried the role, so no second /auth/validate
    // round-trip is needed here. An absent or unrecognized role falls back to viewer, the
    // least-privileged default.
    // platform_admin IS the developer surface: full admin + the /platform pages. Tenant admins map
    // to 'admin' scoped by their account; members map to 'operator'.
    const mapped = user.role === 'platform_admin' ? 'admin' : user.role === 'account_admin' ? 'admin' : 'operator';
    setRole(isUserRole(mapped) ? mapped : 'viewer');
    setAccountId(user.accountId ?? null);
    // A SaaS session token is never session-allowlisted: the tenant keeps every create affordance.
    setScoped(false);

    setIsAuthenticated(true);
  };

  const handleLogout = useCallback(() => {
    setIsAuthenticated(false);
    setRole(null);
    setEngineType(null);
    setScoped(false);
    setAccountId(null);
    sessionStorage.removeItem('openwa_api_key');
    sessionStorage.removeItem('openwa_saas_token');
    sessionStorage.removeItem('openwa_saas_user');
    // Wipe the React Query cache too: it is keyed by resource, not actor, so without a full
    // clear a logout → login in the same tab with a different key/scope shows the previous
    // actor's sessions/messages/apiKeys/audit rows.
    clearActorState(queryClient);
  }, [setRole, setEngineType, setScoped, setAccountId]);

  // Re-validate the SaaS session on mount: /auth/me re-derives role/account from the LIVE user row
  // (a disabled user or suspended tenant is logged out here), so a stale cached role never outlives
  // the server's answer.
  useEffect(() => {
    if (!savedToken) return;
    const stored = sessionStorage.getItem('openwa_saas_user');
    if (!stored) return;
    // Best-effort: the cached user seeds the UI immediately; /auth/me replaces it with the truth.
    let sessionUser: { id: string; email: string; name: string; role: string; accountId: string | null } | null = null;
    try {
      sessionUser = JSON.parse(stored);
    } catch {
      sessionUser = null;
    }
    const mapped = sessionUser
      ? sessionUser.role === 'platform_admin' || sessionUser.role === 'account_admin'
        ? 'admin'
        : 'operator'
      : 'viewer';
    setRole(isUserRole(mapped) ? mapped : 'viewer');
    // Same reasoning as handleLogin: the SaaS token principal is never session-scoped.
    setScoped(false);
    setAccountId(sessionUser?.accountId ?? null);

    saasAuthApi
      .me(savedToken)
      .then(profile => {
        if (sessionStorage.getItem('openwa_saas_token') !== savedToken) return;
        const u = profile.user;
        const next = u.role === 'platform_admin' || u.role === 'account_admin' ? 'admin' : 'operator';
        setRole(isUserRole(next) ? next : 'viewer');
        setAccountId(u.accountId ?? null);
        sessionStorage.setItem('openwa_saas_user', JSON.stringify(u));
      })
      .catch(() => {
        // Invalid/expired token or a suspended tenant: the truth says sign in again.
        if (sessionStorage.getItem('openwa_saas_token') === savedToken) handleLogout();
      });
  }, [savedToken, setRole, setScoped, setAccountId, handleLogout]);

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
            <Route path="/" element={<Layout onLogout={handleLogout} userRole={role} />}>
              <Route index element={<Dashboard />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="chats" element={<Chats />} />
              <Route path="number-checker" element={<NumberChecker />} />
              <Route path="settings" element={<Settings />} />
              {isPlatformAdmin && <Route path="platform" element={<Platform />} />}
              <Route path="webhooks" element={<Webhooks />} />
              <Route path="templates" element={<Templates />} />
              {isPlatformAdmin && <Route path="accounts" element={<Accounts />} />}
              {isPlatformAdmin && <Route path="api-keys" element={<ApiKeys />} />}
              {role === 'admin' && <Route path="logs" element={<Logs />} />}
              <Route path="message-tester" element={<MessageTester />} />
              {isPlatformAdmin && <Route path="infrastructure" element={<Infrastructure />} />}
              {isPlatformAdmin && <Route path="plugins" element={<Plugins />} />}
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
