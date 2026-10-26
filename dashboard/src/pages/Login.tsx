import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Languages } from 'lucide-react';
import { GithubIcon } from '../components/GithubIcon';
import { CustomSelect } from '../components/CustomSelect';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import { saasAuthApi, type SaasUser } from '../services/api';
import './Login.css';

/**
 * The SaaS gate: email + password sign-in, with a sign-up toggle for new tenants — visually the
 * same card the legacy API-key login used (same CSS file, same class names). On success the
 * session token lands in sessionStorage and the tenant's API key (returned by register, picked
 * from Account > API Keys afterwards) authorizes the technical surface.
 */
export function Login({ onLogin }: { onLogin: (token: string, user: SaasUser) => void }) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);

  const changeLanguage = (language: SupportedLanguage) => {
    void i18n.changeLanguage(language);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !password) {
      setError(t(mode === 'login' ? 'saas.loginRequired' : 'saas.registerRequired'));
      return;
    }
    if (mode === 'register' && password.length < 8) {
      setError(t('saas.passwordShort'));
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      if (mode === 'login') {
        // Direct fetch: the login route is PUBLIC, its 401 answer (wrong password, suspended, …)
        // must surface verbatim instead of riding the session-teardown error handler that wipes
        // storage and never resolves.
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: trimmedEmail, password }),
        });
        const body = (await response.json().catch(() => ({}))) as { message?: string } & Record<string, unknown>;
        if (!response.ok) {
          setError(typeof body.message === 'string' ? body.message : t('saas.connectionError'));
          return;
        }
        const session = body as unknown as { token: string; user: SaasUser };
        sessionStorage.setItem('openwa_saas_token', session.token);
        onLogin(session.token, session.user);
        sessionStorage.setItem('openwa_saas_token', session.token);
        onLogin(session.token, session.user);
      } else {
        // Registration provisions the tenant AND its first API key, so the newly-signed-up admin
        // lands on a fully working dashboard: the raw key is shown once here and stored for the tab.
        const created = await saasAuthApi.register({
          email: trimmedEmail,
          password,
          name: name.trim() || undefined,
        });
        sessionStorage.setItem('openwa_saas_token', created.token);
        if (created.apiKey) sessionStorage.setItem('openwa_api_key', created.apiKey);
        onLogin(created.token, created.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saas.connectionError'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <img src="/openwa_logo.webp" alt="OpenWA" className="logo-icon" />
          <span className="version-info">
            {t('login.version', {
              version: __APP_VERSION__,
              date: new Date(__BUILD_TIME__).toISOString().slice(0, 10).replace(/-/g, ''),
            })}
          </span>
        </div>

        <div className="login-language">
          <Languages size={18} />
          <CustomSelect
            value={currentLang}
            onChange={value => changeLanguage(value as SupportedLanguage)}
            options={languageOptions.map(opt => ({ value: opt.value, label: opt.label }))}
            ariaLabel={t('common.language')}
          />
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {mode === 'register' && (
            <div className="input-group">
              <label htmlFor="name">{t('saas.name')}</label>
              <div className="input-wrapper">
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('saas.namePlaceholder')}
                  autoComplete="name"
                />
              </div>
            </div>
          )}

          <div className="input-group">
            <label htmlFor="email">{t('saas.email')}</label>
            <div className="input-wrapper">
              <input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder={t('saas.emailPlaceholder')}
                autoComplete="email"
                className={error ? 'error' : ''}
              />
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="password">{t('saas.password')}</label>
            <div className="input-wrapper">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t(mode === 'register' ? 'saas.passwordPlaceholderNew' : 'saas.passwordPlaceholder')}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                className={error ? 'error' : ''}
              />
              <button type="button" className="toggle-visibility" onClick={() => setShowPassword(v => !v)}>
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {error && (
            <span className="error-message" role="alert">
              {error}
            </span>
          )}

          <button type="submit" className="connect-btn" disabled={isLoading}>
            {isLoading ? '…' : t(mode === 'login' ? 'saas.signIn' : 'saas.signUp')}
          </button>

          <div className="login-help">
            <button
              type="button"
              className="login-switch"
              onClick={() => {
                setMode(m => (m === 'login' ? 'register' : 'login'));
                setError('');
              }}
            >
              {mode === 'login' ? t('saas.needAccount') : t('saas.haveAccount')}
            </button>
          </div>
        </form>

        <div className="login-footer">
          <a className="github-link" href="https://github.com/rmyndharis/openwa" target="_blank" rel="noreferrer">
            <GithubIcon /> GitHub
          </a>
        </div>
      </div>
    </div>
  );
}
