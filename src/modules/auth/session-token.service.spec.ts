import { SessionTokenService } from './session-token.service';

/**
 * The dashboard-token secret precedence: explicit SAAS_JWT_SECRET, then an HKDF-style derivation
 * from API_MASTER_KEY (persistent and replica-stable), then a random ephemeral secret. The
 * `persistent` flag is what tells boot/ops whether a restart logs every user out.
 */
describe('SessionTokenService secret precedence', () => {
  const saved = { jwt: process.env.SAAS_JWT_SECRET, master: process.env.API_MASTER_KEY };

  afterEach(() => {
    if (saved.jwt === undefined) delete process.env.SAAS_JWT_SECRET;
    else process.env.SAAS_JWT_SECRET = saved.jwt;
    if (saved.master === undefined) delete process.env.API_MASTER_KEY;
    else process.env.API_MASTER_KEY = saved.master;
  });

  it('uses SAAS_JWT_SECRET when it is 32+ chars', () => {
    process.env.SAAS_JWT_SECRET = 'x'.repeat(32);
    delete process.env.API_MASTER_KEY;
    const service = new SessionTokenService();
    expect(service.persistent).toBe(true);
    expect(service.secretForDerivation()).toBe('x'.repeat(32));
  });

  it('derives a PERSISTENT secret from API_MASTER_KEY when SAAS_JWT_SECRET is absent', () => {
    delete process.env.SAAS_JWT_SECRET;
    process.env.API_MASTER_KEY = 'm'.repeat(40);
    const a = new SessionTokenService();
    const b = new SessionTokenService();
    expect(a.persistent).toBe(true);
    // Deterministic across processes: the same master key derives the same secret.
    expect(a.secretForDerivation()).toBe(b.secretForDerivation());
    // And it is NOT the master key itself.
    expect(a.secretForDerivation()).not.toBe('m'.repeat(40));
  });

  it('falls back to a short SAAS_JWT_SECRET only when API_MASTER_KEY cannot derive one', () => {
    process.env.SAAS_JWT_SECRET = 'short';
    delete process.env.API_MASTER_KEY;
    const service = new SessionTokenService();
    expect(service.persistent).toBe(false);
  });

  it('a short SAAS_JWT_SECRET still yields a persistent secret when API_MASTER_KEY is strong', () => {
    process.env.SAAS_JWT_SECRET = 'short';
    process.env.API_MASTER_KEY = 'm'.repeat(64);
    const service = new SessionTokenService();
    expect(service.persistent).toBe(true);
    expect(service.secretForDerivation()).not.toBe('short');
  });

  it('is ephemeral only when neither is usable, and tokens still round-trip', () => {
    delete process.env.SAAS_JWT_SECRET;
    process.env.API_MASTER_KEY = 'too-short';
    const service = new SessionTokenService();
    expect(service.persistent).toBe(false);
    const { token } = service.issue({ sub: 'u1', email: 'a@b.test', role: 'account_admin' as never, accountId: 'acc-a' });
    expect(service.verify(token)?.sub).toBe('u1');
  });
});
