
/**
 * Shared masking for write-only credentials (LLM api keys, MCP auth credentials).
 *
 * The stored value is a bearer token; showing any of it beyond a short tail is a needless leak, so
 * a long secret keeps its first 4 and last 4 characters (enough to tell two keys apart in the
 * dashboard) and a short one is masked entirely.
 */
export function maskSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  if (secret.length <= 8) return '••••••••';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/**
 * Runtime integrity guard on stored sampling parameters. A data restore (or a hand-edited row)
 * bypasses the DTO, and a provider that receives `temperature: 99` or `stop: 'a very long string'`
 * either errors out or bills far more than the operator intended — so the values are re-checked
 * here, at the point of use.
 */
export function sanitizeLlmParameters(parameters: unknown): {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
} | null {
  if (parameters == null || typeof parameters !== 'object' || Array.isArray(parameters)) return null;
  const { temperature, maxTokens, topP, stop } = parameters as Record<string, unknown>;
  const out: { temperature?: number; maxTokens?: number; topP?: number; stop?: string[] } = {};
  if (
    typeof temperature === 'number' &&
    Number.isFinite(temperature) &&
    temperature >= 0 &&
    temperature <= 2
  ) {
    out.temperature = temperature;
  }
  if (
    typeof maxTokens === 'number' &&
    Number.isInteger(maxTokens) &&
    maxTokens > 0 &&
    maxTokens <= 128_000
  ) {
    out.maxTokens = maxTokens;
  }
  if (typeof topP === 'number' && Number.isFinite(topP) && topP > 0 && topP <= 1) {
    out.topP = topP;
  }
  if (Array.isArray(stop)) {
    const words = stop
      .filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 64)
      .slice(0, 4);
    if (words.length > 0) out.stop = words;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Runtime integrity guard on stored custom headers. A header map reaching a provider request can
 * shadow the gateway's own headers (`authorization`, `content-type`, `host`), so those names are
 * dropped here rather than trusted from a restored row.
 */
const RESERVED_HEADERS = new Set([
  'authorization',
  'content-type',
  'content-length',
  'host',
  'connection',
  'transfer-encoding',
  'accept-encoding',
]);

export function sanitizeHeaderMap(headers: unknown): Record<string, string> {
  if (headers == null || typeof headers !== 'object' || Array.isArray(headers)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    const name = key.trim();
    if (name.length === 0 || name.length > 128) continue;
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    if (typeof value !== 'string' || value.length > 2048) continue;
    out[name] = value;
  }
  return out;
}
