# 02 - Multi-Account (Tenants)

One OpenWA deployment can serve several **accounts** (tenants). An account is a namespace that
owns WhatsApp sessions and the API keys that operate them; nothing else is duplicated — one
process, one engine registry, one database per install.

```
accounts (main DB)          api_keys (main DB)              sessions (data DB)
┌──────────────┐            ┌────────────────────┐          ┌──────────────────────┐
│ id           │◄───────────│ accountId (NULL =  │          │ id                   │
│ name         │            │   global key)      │          │ accountId (NULL =    │
│ note         │            │ role, allowed*s    │          │   pre-accounts row)  │
│ isActive     │            └────────────────────┘          │ name, status, …      │
└──────────────┘                    │                       └──────────────────────┘
                                    │  requests name a session id
                                    ▼
                         ApiKeyGuard → AuthService.validateApiKey
                         session.accountId ∈ {NULL, key.accountId}  else 403
```

## Isolation rules

| Actor | Sessions it lists | Session it can use | `/accounts` | Issues keys |
| --- | --- | --- | --- | --- |
| Account key | its own account's | its own account's (or an unowned/global one) | 403 (unscoped-only route) | only for its own account |
| Global key (no account) | every session | every session | yes, if ADMIN | for any account |

- The REST guard resolves the owning account of every `:sessionId` route param — on **every**
  controller, not only `@SessionScoped` ones — and refuses a foreign session with
  `403 API key is not authorized for this account`. A `:id` param counts as a session only on
  controllers marked `@SessionScoped` (elsewhere `:id` is an unrelated resource id).
- The WebSocket gateway applies the same rule to subscriptions: an account key cannot subscribe to
  `*` (that would carry every tenant's events) nor to a foreign session.
- `GET /api/sessions` filters by the key's account; `POST /api/sessions` stamps the key's account on
  the new row. A global key creates global (account-less) sessions, exactly as before.
- Account keys are refused on every `@RequireUnscopedKey` surface (API-key lifecycle, accounts,
  infrastructure, plugins, AI/LLM connections), whatever their role — the same fence a
  session-scoped key hits.
- Session names stay globally unique (one QR data directory per name). A taken name answers `409`
  to every tenant.

## API

| Route | Role | Purpose |
| --- | --- | --- |
| `POST /api/accounts` | OPERATOR (global key) | Create an account: `{ name, note? }` |
| `GET /api/accounts` | OPERATOR (global key) | List accounts |
| `GET /api/accounts/:id` | OPERATOR (global key) | One account |
| `PUT /api/accounts/:id` | OPERATOR (global key) | Update name / note / `isActive` |
| `DELETE /api/accounts/:id` | ADMIN (global key) | Delete — refused (`409`) while sessions or keys remain |
| `POST /api/accounts/:id/api-keys` | ADMIN (global key) | Issue an account key; the raw key is returned once |
| `GET /api/accounts/:id/api-keys` | ADMIN (global key) | The account's keys (masked) |

`POST /api/auth/validate` now answers `{ valid, role, engineType, scoped, accountId }`; `scoped`
is true for an account key as well (the dashboard uses both to gate its navigation and to show the
tenant chip).

## Dashboard

Admin keys see **Accounts** in the sidebar. Creating an account, then issuing a key for it
(`POST /api/accounts/{id}/api-keys`), gives that tenant everything else — sessions, chats,
messages, webhooks, templates, AI chatbots — confined to its account. The sidebar shows the
active tenant's id; a global key shows none.

## Migrations

- `migrations-main/1787500000000-AddAccounts` — the `accounts` table plus `api_keys.accountId`
  (NULL on every existing row).
- `migrations/1797800000000-AddSessionAccount` — `sessions.accountId` (NULL on every existing
  session).

Existing installs need no action: every existing key and session is global, so behaviour is
unchanged until an account key is issued.

## Operational notes

- Deleting an account requires deleting (or keeping) its sessions and revoking its keys first.
- The account binding of a session is cached for 10 s in the auth service (REST + WebSocket share
  the cache); a session's owner never changes after creation, so the only observable effect is that a
  just-deleted session keeps resolving to its old owner for at most that window.
- The engine layer stays per-process: accounts do not add replicas. Each tenant's sessions still run
  in the same Node process (see [13 - Horizontal Scaling](13-horizontal-scaling.md)).
