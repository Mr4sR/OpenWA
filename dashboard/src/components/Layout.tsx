import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  Smartphone,
  MessageSquare,
  ShieldCheck,
  Settings as SettingsIcon,
  Webhook,
  Key,
  FileText,
  ClipboardList,
  LogOut,
  Send,
  Server,
  Puzzle,
  Sun,
  Moon,
  Monitor,
  Menu,
  X,
  ChevronLeft,
  ChevronRight,
  Languages,
  UserCheck,
  Sparkles,
} from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { usePaneResizer } from '../hooks/usePaneResizer';
import { useRole } from '../hooks/useRole';
import { canManageDeployment } from '../utils/authLifecycle';
import { languageOptions, resolveSupportedLanguage, rtlLanguages, type SupportedLanguage } from '../i18n';
import { healthApi, infraApi } from '../services/api';
import './Layout.css';

interface LayoutProps {
  onLogout: () => void;
  /** The developer surface is admitted only to a platform_admin login; App derives it from the session. */
  canViewPlatform: boolean;
}

// Each flag is one server fence, so a hidden entry and its absent route can never disagree:
// adminOnly — the route requires the ADMIN role.
// deploymentOnly — @RequireRole(ADMIN) + @RequireUnscopedKey: ADMIN with no session allowlist and no
//   account, i.e. the deployment-global surface. A tenant admin is ADMIN inside its account only.
// platformOnly — the developer surface, admitted only to a platform_admin login.
const allNavItems: Array<{
  to: string;
  icon: typeof LayoutDashboard;
  key: string;
  adminOnly?: boolean;
  deploymentOnly?: boolean;
  platformOnly?: boolean;
}> = [
  { to: '/', icon: LayoutDashboard, key: 'dashboard' as const },
  { to: '/sessions', icon: Smartphone, key: 'sessions' as const },
  { to: '/chats', icon: MessageSquare, key: 'chats' as const },
  { to: '/number-checker', icon: UserCheck, key: 'numberChecker' as const },
  { to: '/webhooks', icon: Webhook, key: 'webhooks' as const },
  { to: '/templates', icon: ClipboardList, key: 'templates' as const },
  { to: '/accounts', icon: ShieldCheck, key: 'accounts' as const, deploymentOnly: true },
  { to: '/settings', icon: SettingsIcon, key: 'settings' as const },
  { to: '/platform', icon: ShieldCheck, key: 'platform' as const, platformOnly: true },
  { to: '/api-keys', icon: Key, key: 'apiKeys' as const, deploymentOnly: true },
  { to: '/message-tester', icon: Send, key: 'messageTester' as const },
  // Backend /infra/* is ADMIN-only and unscoped-only; hide the nav item otherwise (UX + defense-in-depth).
  { to: '/infrastructure', icon: Server, key: 'infrastructure' as const, deploymentOnly: true },
  { to: '/plugins', icon: Puzzle, key: 'plugins' as const, deploymentOnly: true },
  // NOT deploymentOnly: the AI routes accept an account principal and scope every row by account,
  // so a tenant admin manages their own models/chatbots from this page.
  { to: '/ai-integration', icon: Sparkles, key: 'aiIntegration' as const, adminOnly: true },
  // Backend /audit is ADMIN-only too.
  { to: '/logs', icon: FileText, key: 'logs' as const, adminOnly: true },
];

const themeIcons = { light: Sun, dark: Moon, system: Monitor };

export function Layout({ onLogout, canViewPlatform }: LayoutProps) {
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const ThemeIcon = themeIcons[theme];
  const themeLabel = t(`theme.${theme}`);
  // toggleTheme cycles light, dark, system; the button names the state a click selects.
  const nextThemeLabel = t('theme.toggleTo', {
    value: t(`theme.${theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'}`),
  });

  const { role, scoped, accountId } = useRole();
  // The same predicate App uses for the routes: /accounts, /api-keys, /infra and /plugins are
  // ADMIN-only AND @RequireUnscopedKey, so a tenant admin or a scoped key is offered no entry there.
  const canManageDeploymentPages = canManageDeployment(role, scoped, accountId);
  const navItems = allNavItems.filter(
    item =>
      (!item.adminOnly || role === 'admin') &&
      (!item.deploymentOnly || canManageDeploymentPages) &&
      (!item.platformOnly || canViewPlatform),
  );

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  // VS Code-style nav width: drag the sidebar's inner edge, double-click/Enter restores 260px.
  // Collapsing still wins (72px); the saved width returns when the nav is expanded again.
  const { containerRef: layoutRef, sashProps: navSashProps } = usePaneResizer(t('common.panelResize'), {
    cssVar: '--sidebar-w',
    storageKey: 'openwa_nav_width',
  });
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  // Show the build-time version immediately, then replace it with the live running version from the
  // backend so a stale-built bundle can't display the wrong number. Falls back silently on error.
  const [version, setVersion] = useState(__APP_VERSION__);
  // A newer published release, shown to admins as a link to its notes. The route is ADMIN-only, refuses a
  // session-scoped key, and answers quietly when GitHub is unreachable or the check is turned off.
  const [update, setUpdate] = useState<{ latest: string; url: string } | null>(null);
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
  const languageMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setIsMobileOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    let active = true;
    healthApi
      .check()
      .then(info => {
        if (active && info?.version) setVersion(info.version);
      })
      .catch(() => {
        /* keep the build-time fallback */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    // GET /infra/update-check is ADMIN-only behind the class-level @RequireUnscopedKey, so the same
    // predicate that hides its page decides whether to ask at all.
    if (!canManageDeploymentPages) return;
    let active = true;
    infraApi
      .getUpdateCheck()
      .then(check => {
        if (active && check.updateAvailable && check.latest && check.releaseUrl) {
          setUpdate({ latest: check.latest, url: check.releaseUrl });
        }
      })
      .catch(() => {
        /* no notice */
      });
    return () => {
      active = false;
    };
  }, [canManageDeploymentPages]);

  const handleNavClick = () => {
    if (isMobile) setIsMobileOpen(false);
  };

  useEffect(() => {
    document.body.style.overflow = isMobileOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileOpen]);

  useEffect(() => {
    if (!isLanguageMenuOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!languageMenuRef.current?.contains(event.target as Node)) {
        setIsLanguageMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsLanguageMenuOpen(false);
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isLanguageMenuOpen]);

  const toggleCollapse = () => setIsCollapsed(!isCollapsed);
  const toggleMobile = () => setIsMobileOpen(!isMobileOpen);

  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);
  const languageLabel = languageOptions.find(option => option.value === currentLang)?.compactLabel ?? 'EN';
  const changeLanguage = (language: SupportedLanguage) => {
    setIsLanguageMenuOpen(false);
    void i18n.changeLanguage(language);
  };
  const isRtl = rtlLanguages.includes(currentLang);

  return (
    <div className="layout" ref={layoutRef}>
      {isMobile && (
        <header className="mobile-header">
          <button className="mobile-menu-btn" onClick={toggleMobile} aria-label={t('common.expand')}>
            {isMobileOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
          <div className="mobile-brand">
            <img src="/openwa_logo.webp" alt="OpenWA" className="sidebar-logo" />
            <span className="brand-name">{t('common.appName')}</span>
          </div>
          <div style={{ width: 40 }} />
        </header>
      )}

      {isMobile && isMobileOpen && <div className="sidebar-overlay" onClick={() => setIsMobileOpen(false)} />}

      <aside
        className={`sidebar ${isCollapsed ? 'collapsed' : ''} ${isMobile ? 'mobile' : ''} ${isMobileOpen ? 'open' : ''}`}
      >
        <div className="sidebar-header">
          <img src="/openwa_logo.webp" alt="OpenWA" className="sidebar-logo" />
          {!isCollapsed && (
            <div className="sidebar-brand">
              <span className="brand-name">{t('common.appName')}</span>
              <span className="brand-version">v{version}</span>
              {/* The tenant this tab's key acts for; a global key (null) reads as the operator view. */}
              {accountId && (
                <span className="brand-account" title={t('accounts.activeAccount')}>
                  {t('accounts.activeAccount')}: {accountId.slice(0, 8)}
                </span>
              )}
              {update && (
                <a className="brand-update" href={update.url} target="_blank" rel="noopener noreferrer">
                  {t('common.updateAvailable', { version: update.latest })}
                </a>
              )}
            </div>
          )}
        </div>

        {!isMobile && (
          <button
            className="collapse-toggle"
            onClick={toggleCollapse}
            title={isCollapsed ? t('common.expand') : t('common.collapse')}
            aria-label={isCollapsed ? t('common.expand') : t('common.collapse')}
          >
            {isCollapsed ? (
              isRtl ? (
                <ChevronLeft size={16} />
              ) : (
                <ChevronRight size={16} />
              )
            ) : isRtl ? (
              <ChevronRight size={16} />
            ) : (
              <ChevronLeft size={16} />
            )}
          </button>
        )}

        {/* The sash lives on the sidebar's trailing edge and straddles the fixed nav's boundary. */}
        {!isMobile && !isCollapsed && <div {...navSashProps} />}

        <nav className="sidebar-nav">
          {navItems.map(({ to, icon: Icon, key }) => {
            const label = t(`nav.${key}`);
            return (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                end={to === '/'}
                onClick={handleNavClick}
                title={isCollapsed ? label : undefined}
              >
                <Icon size={20} />
                {!isCollapsed && <span>{label}</span>}
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="language-menu" ref={languageMenuRef}>
            <button
              className="theme-toggle-btn"
              onClick={() => setIsLanguageMenuOpen(open => !open)}
              title={t('common.language')}
              aria-label={t('common.language')}
              aria-haspopup="menu"
              aria-expanded={isLanguageMenuOpen}
            >
              <Languages size={18} />
              {!isCollapsed && <span>{languageLabel}</span>}
            </button>
            {isLanguageMenuOpen && (
              <div className="language-menu-list" role="menu" aria-label={t('common.language')}>
                {languageOptions.map(option => (
                  <button
                    key={option.value}
                    className={`language-menu-item ${option.value === currentLang ? 'active' : ''}`}
                    onClick={() => changeLanguage(option.value)}
                    role="menuitemradio"
                    aria-checked={option.value === currentLang}
                  >
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="appearance-menu">
            <button
              className="theme-toggle-btn"
              onClick={toggleTheme}
              title={nextThemeLabel}
              aria-label={nextThemeLabel}
            >
              <span className="appearance-button-cue" aria-hidden="true">
                <ThemeIcon size={16} />
              </span>
              {!isCollapsed && <span>{themeLabel}</span>}
            </button>
          </div>
          <button className="logout-btn" onClick={onLogout} title={isCollapsed ? t('common.logout') : undefined}>
            <LogOut size={20} />
            {!isCollapsed && <span>{t('common.logout')}</span>}
          </button>
        </div>
      </aside>

      <main className={`main-content ${isCollapsed ? 'expanded' : ''} ${isMobile ? 'mobile' : ''}`}>
        <Outlet />
      </main>
    </div>
  );
}
