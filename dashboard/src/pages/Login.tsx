import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Languages, Mail, User as UserIcon } from 'lucide-react';
import { GithubIcon } from '../components/GithubIcon';
import { CustomSelect } from '../components/CustomSelect';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import { saasAuthApi, type SaasUser } from '../services/api';
import './Login.css';

/**
 * The SaaS gate: email + password sign-in, with a sign-up toggle for new tenants. On success the
 * session token lands in sessionStorage (`openwa_saas_token`) and the account's API key (picked
 * next on the post-login flow) rides separately — the token proves WHO, the key proves WHAT.
 */
export function Login({
  onLogin,
}: {
  onLogin: (token: string, user: SaasUser) => void;
}) {
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
        const session = await saasAuthApi.login({ email: trimmedEmail, password });
        sessionStorage.setItem('openwa_saas_token', session.token);
        onLogin(session.token, session.user);
      } else {
        // Registration returns the session PLUS the tenant's first API key (raw value shown once).
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
                <UserIcon size={18} className="input-icon" />
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
              <Mail size={18} className="input-icon" />
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

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="login-button" disabled={isLoading}>
            {isLoading ? '…' : t(mode === 'login' ? 'saas.signIn' : 'saas.signUp')}
          </button>

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
        </form>

        <div className="login-footer">
          <a href="https://github.com/rmyndharis/openwa" target="_blank" rel="noreferrer">
            <GithubIcon /> GitHub
          </a>
        </div>
      </div>
    </div>
  );
}
