import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { withSafeFetch, redactSsrfError } from '../../common/security/ssrf-guard';
import type { Response as undiciResponse } from 'undici';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { sanitizeHeaderMap, sanitizeLlmParameters } from './ai-secrets';
import { AiLlmModel } from './entities/ai-llm-model.entity';
import { CreateAiLlmModelDto, UpdateAiLlmModelDto } from './dto/ai-llm-model.dto';

/** Per-instance cap: every chatbot completion resolves through one of these rows. */
export const AI_LLM_MODELS_MAX = 50;

/** Wall-clock ceiling of one completion call (chatbot reply path + provider test share it). */
export const LLM_REQUEST_TIMEOUT_MS = 60_000;

/** The sampling defaults the dashboard placeholders advertise; a create without parameters gets them. */
export const DEFAULT_LLM_PARAMETERS = { temperature: 0.7, maxTokens: 1024 };

/**
 * A valid 1×1 PNG (70 bytes) for the vision capability probe: the provider must accept an
 * image_url content part and answer with text for the chatbot to route customer photos to it.
 */
const VISION_PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** A completion answer is bounded by the reply cap; anything past it is a broken provider. */
export const LLM_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * CRUD for LLM provider connections plus the single completion call every AI feature (chatbot
 * replies, RAG indexing/retrieval) goes through: one POST to `<endpointUrl>/chat/completions` in
 * the OpenAI wire format, which is the de-facto dialect of OpenAI, Anthropic (via its compat
 * layer), Mistral, Groq, DeepSeek, Ollama, vLLM and the hosted gateways.
 *
 * Outbound calls run through {@link withSafeFetch} (the SSRF guard): a self-hosted gateway accepts
 * operator-managed endpoint URLs, but the same DB write path also serves bulk imports, so the URL
 * is re-validated at call time and a redirect to an internal address is refused.
 */
@Injectable()
export class AiLlmModelsService {
  private readonly logger = createLogger('AiLlmModelsService');

  constructor(
    @InjectRepository(AiLlmModel, 'data')
    private readonly repository: Repository<AiLlmModel>,
    private readonly audit: AuditService,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  /**
   * Create a provider connection owned by `accountId` (NULL = the platform/global surface). The
   * row is the tenant's own credential, so only that account ever reads it back.
   */
  async create(dto: CreateAiLlmModelDto, accountId: string | null = null): Promise<AiLlmModel> {
    const existing = await this.repository.count({ where: accountId === null ? { accountId: IsNull() } : { accountId } });
    const max = this.configService?.get<number>('ai.llmModelsMax', AI_LLM_MODELS_MAX) ?? AI_LLM_MODELS_MAX;
    if (max > 0 && existing >= max) {
      throw new BadRequestException(`LLM model limit reached (${existing}/${max}); delete one before adding another`);
    }
    // The unique index on `name` would surface as a driver 500; a duplicate is an ordinary client
    // error the dashboard renders inline.
    if (await this.repository.exists({ where: { name: dto.name } })) {
      throw new BadRequestException(`An LLM model named '${dto.name}' already exists`);
    }
    // Endpoint URL is validated structurally here (scheme required) — the SSRF guard runs at call
    // time, so a localhost endpoint stays configurable and only a non-http(s) value is refused now.
    assertHttpUrl(dto.endpointUrl);
    const model = this.repository.create({
      accountId,
      name: dto.name,
      endpointUrl: dto.endpointUrl.replace(/\/+$/, ''),
      apiKey: dto.apiKey ?? '',
      model: dto.model ?? '',
      parameters: sanitizeLlmParameters(dto.parameters ?? DEFAULT_LLM_PARAMETERS),
      headers: Object.keys(dto.headers ?? {}).length > 0 ? sanitizeHeaderMap(dto.headers) : {},
      enabled: dto.enabled ?? true,
    });
    const saved = await this.repository.save(model);
    void this.audit.logInfo(AuditAction.AI_LLM_MODEL_CREATED, {
      metadata: { llmModelId: saved.id, llmModelName: saved.name, accountId },
    });
    this.probeInBackground(saved);
    return saved;
  }

  /**
   * The one connection test: a minimal completion (the model id, key and endpoint answer at all),
   * then the capability probe (vision). Never throws — the outcome is the return value, so the
   * dashboard renders a refusal inline and the background probe can record it.
   */
  async test(model: AiLlmModel): Promise<{ ok: boolean; answer: string; capabilities: LlmCapabilities | null }> {
    try {
      const answer = await this.complete(model, [{ role: 'user', content: 'ping' }]);
      const capabilities = await this.probeCapabilities(model);
      // The probe already made the proving completion; a second ping would just spend the quota.
      return { ok: true, answer: answer.slice(0, 200), capabilities };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, answer: detail.slice(0, 300), capabilities: null };
    }
  }

  /**
   * Run the connection test the moment a model is saved, so the operator learns at save time
   * whether the id/key/endpoint work and whether the model sees images. Detached and best-effort:
   * a slow or unreachable provider never delays the HTTP response, and its outcome lands on the
   * row (`lastStatus`, `capabilities`) for the dashboard card and the chatbot's image routing.
   */
  private probeInBackground(model: AiLlmModel): void {
    void (async () => {
      try {
        const result = await this.test(model);
        await this.recordStatus(
          model.id,
          {
            ok: result.ok,
            capabilities: result.capabilities ?? undefined,
            ...(result.ok ? {} : { error: result.answer }),
          },
          model.accountId,
        );
      } catch (error) {
        this.logger.warn('Background capability probe failed', {
          llmModelId: model.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }

  async findAll(accountId: string | null = null): Promise<AiLlmModel[]> {
    return this.repository.find({
      where: accountId === null ? { accountId: IsNull() } : { accountId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  /**
   * One model, visible only to its owner: another account's row (and an unknown id) is a NotFound,
   * so a tenant cannot even confirm a foreign model exists. A NULL account sees NULL rows only —
   * the bare `{ accountId: null }` form would be read by TypeORM as "no condition".
   */
  async findOne(id: string, accountId: string | null = null): Promise<AiLlmModel> {
    const model = await this.repository.findOne({
      where: accountId === null ? { id, accountId: IsNull() } : { id, accountId },
    });
    if (!model) {
      throw new NotFoundException(`LLM model ${id} not found`);
    }
    return model;
  }

  async update(id: string, dto: UpdateAiLlmModelDto, accountId: string | null = null): Promise<AiLlmModel> {
    const model = await this.findOne(id, accountId);
    if (dto.name !== undefined) model.name = dto.name;
    if (dto.endpointUrl !== undefined) {
      assertHttpUrl(dto.endpointUrl);
      model.endpointUrl = dto.endpointUrl.replace(/\/+$/, '');
    }
    if (dto.apiKey !== undefined) model.apiKey = dto.apiKey;
    if (dto.model !== undefined) model.model = dto.model;
    if (dto.parameters !== undefined) model.parameters = sanitizeLlmParameters(dto.parameters);
    if (dto.headers !== undefined) model.headers = sanitizeHeaderMap(dto.headers);
    if (dto.enabled !== undefined) model.enabled = dto.enabled;
    const saved = await this.repository.save(model);
    void this.audit.logInfo(AuditAction.AI_LLM_MODEL_UPDATED, {
      metadata: { llmModelId: saved.id, llmModelName: saved.name, accountId },
    });
    // Endpoint, key or model id may all have changed: the stored capabilities describe a test
    // against the OLD combination until this re-probe lands.
    this.probeInBackground(saved);
    return saved;
  }

  async remove(id: string, accountId: string | null = null): Promise<void> {
    const model = await this.findOne(id, accountId);
    await this.repository.remove(model);
    void this.audit.logInfo(AuditAction.AI_LLM_MODEL_DELETED, {
      metadata: { llmModelId: id, llmModelName: model.name },
    });
  }

  /**
   * Record connection-test diagnostics plus the capabilities the probe proved. Best-effort, and
   * scoped to the owning account: the probe is detached from the request, so the owner travels
   * with the call and a foreign row is never written.
   */
  async recordStatus(
    id: string,
    status: { ok: boolean; error?: string; capabilities?: { vision: boolean; at: string } },
    accountId: string | null = null,
  ): Promise<void> {
    try {
      await this.repository.update(
        accountId === null ? { id, accountId: IsNull() } : { id, accountId },
        {
          lastStatus: { ok: status.ok, at: new Date().toISOString(), ...(status.error ? { error: status.error } : {}) },
          lastTestedAt: new Date(),
          ...(status.capabilities ? { capabilities: status.capabilities } : {}),
        },
      );
      void this.audit.logInfo(AuditAction.AI_LLM_MODEL_TESTED, {
        metadata: {
          llmModelId: id,
          ok: status.ok,
          ...(status.capabilities ? { vision: status.capabilities.vision } : {}),
          ...(status.error ? { error: status.error.slice(0, 200) } : {}),
        },
      });
    } catch (error) {
      this.logger.warn('Failed to record LLM connection status', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Probe what the provider connection can actually do. One minimal text completion proves the
   * endpoint/key/model id (it throws on refusal); a second completion over a 1×1 PNG proves
   * vision. Vision failure is RECORDED, not thrown: an image-blind model is still a working
   * connection, and the chatbot routes images around it.
   */
  async probeCapabilities(model: AiLlmModel): Promise<{ vision: boolean; at: string }> {
    const at = new Date().toISOString();
    await this.complete(model, [{ role: 'user', content: 'ping' }]);
    try {
      await this.complete(model, [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${VISION_PROBE_PNG_BASE64}` } },
            { type: 'text', text: 'Reply with the single word: yes' },
          ],
        },
      ]);
      return { vision: true, at };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.debug('Vision probe did not pass', { llmModelId: model.id, error: detail.slice(0, 200) });
      return { vision: false, at };
    }
  }

  /**
   * One chat completion. `messages` arrives pre-built by the caller (persona, RAG context,
   * history); this only adds the endpoint, the key and the sampling parameters. A user turn may
   * ride the OpenAI multimodal shape — `content` as an array of `{type:'text'|'image_url', …}`
   * parts — which the provider answers or refuses as a normal provider error.
   */
  async complete(model: AiLlmModel, messages: CompletionRequestMessage[]): Promise<string> {
    const parsed = await this.chatCompletions(model, { messages });
    const content = extractCompletionContent(parsed);
    if (!content) {
      const choice = parsed.choices?.[0];
      const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'unknown';
      const messageKeys = choice?.message ? Object.keys(choice.message).join(', ') : '(no message)';
      throw new Error(
        `LLM ${chatCompletionsUrl(model.endpointUrl)} returned JSON without completion content. finish_reason: ${finish}; message keys: ${messageKeys}. ` +
          'If finish_reason is "length", raise the model maxTokens — reasoning models spend it on hidden thinking first.',
      );
    }
    return content;
  }

  /**
   * One chat completion with OpenAI tool-calling: `tools` rides the request, and when the model
   * answers with `tool_calls` (nothing textual), the FULL provider turn comes back so the caller
   * can execute the tools, append the assistant turn + tool results and ask again. Non-streaming
   * on purpose — the chatbot loop needs the structured turn, not a token stream.
   */
  async completeWithTools(
    model: AiLlmModel,
    messages: Array<ChatCompletionMessage>,
    tools: Array<{
      type: 'function';
      function: { name: string; description?: string; parameters: Record<string, unknown> };
    }>,
  ): Promise<{ content: string | null; toolCalls: ToolCallRequest[]; rawAssistant: unknown }> {
    const body: Record<string, unknown> = { messages, tools };
    const parsed = await this.chatCompletions(model, body);
    const choice = parsed.choices?.[0];
    const rawToolCalls = choice?.message?.tool_calls;
    const toolCalls: ToolCallRequest[] = Array.isArray(rawToolCalls)
      ? rawToolCalls
          .map((call: RawToolCall, index: number) => {
            const fn = call?.function;
            if (!fn || typeof fn.name !== 'string' || fn.name.length === 0) return null;
            let args: Record<string, unknown> = {};
            if (typeof fn.arguments === 'string' && fn.arguments.trim().length > 0) {
              try {
                const value: unknown = JSON.parse(fn.arguments);
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                  args = value as Record<string, unknown>;
                }
              } catch {
                // A malformed arguments JSON is reported to the MODEL as a tool error, so it can
                // correct itself on the next turn — not a thrown 400.
                args = {};
                return {
                  id: typeof call.id === 'string' ? call.id : `call_${index}`,
                  name: fn.name,
                  args,
                  parseError: 'arguments were not valid JSON',
                };
              }
            }
            return {
              id: typeof call.id === 'string' ? call.id : `call_${index}`,
              name: fn.name,
              args,
            };
          })
          .filter((call): call is ToolCallRequest => call !== null)
          .slice(0, MAX_TOOL_CALLS_PER_TURN)
      : [];
    const content = extractCompletionContent(parsed);
    return { content, toolCalls, rawAssistant: choice?.message ?? null };
  }

  /** The one POST every completion goes through; adds endpoint/key/parameters and parses the JSON. */
  private async chatCompletions(model: AiLlmModel, body: Record<string, unknown>): Promise<CompletionResponse> {
    const payload: Record<string, unknown> = { model: model.model || undefined, ...body };
    const parameters = sanitizeLlmParameters(model.parameters);
    if (parameters) {
      if (parameters.temperature !== undefined) payload.temperature = parameters.temperature;
      if (parameters.maxTokens !== undefined) payload.max_tokens = parameters.maxTokens;
      if (parameters.topP !== undefined) payload.top_p = parameters.topP;
      if (parameters.stop !== undefined) payload.stop = parameters.stop;
    }
    const url = chatCompletionsUrl(model.endpointUrl);
    let answer: string;
    try {
      answer = await withSafeFetch(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
            ...sanitizeHeaderMap(model.headers),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
        },
        async (response: undiciResponse) => {
          if (!response.ok) {
            const detail = (await response.text()).slice(0, 300);
            throw new Error(`LLM HTTP ${response.status} from ${url}: ${detail || '(empty body)'}`);
          }
          // Responses are small JSON docs; the byte cap turns a runaway provider into an error
          // instead of an unbounded buffer.
          const reader = response.body;
          if (!reader) throw new Error(`LLM ${url} returned an empty body`);
          const chunks: Uint8Array[] = [];
          let total = 0;
          const scan = reader.getReader();
          for (;;) {
            const { done, value } = await scan.read();
            if (done) break;
            total += value.byteLength;
            if (total > LLM_RESPONSE_MAX_BYTES) {
              await scan.cancel().catch(() => undefined);
              throw new Error('LLM response exceeded the size cap');
            }
            chunks.push(value);
          }
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return new TextDecoder().decode(merged);
        },
        { guard: process.env.WEBHOOK_SSRF_PROTECT !== 'false' },
      );
    } catch (error) {
      const message = redactSsrfError(error);
      // undici's AbortSignal.timeout raises a bare "The operation was aborted due to timeout",
      // which tells the operator nothing. Name the endpoint and the budget instead.
      if (/aborted due to timeout|TimeoutError/i.test(message)) {
        throw new Error(
          `LLM request to ${url} timed out after ${Math.round(LLM_REQUEST_TIMEOUT_MS / 1000)}s. ` +
            'The provider did not answer in time — check the endpoint URL and the provider status.',
        );
      }
      throw new Error(message);
    }

    let parsed: CompletionResponse;
    try {
      parsed = JSON.parse(answer) as CompletionResponse;
    } catch {
      // A gateway that answers with HTML (a login page, a proxy error) or plain text is NOT a
      // valid completion. Show what came back instead of a bare "non-JSON body".
      const preview = answer.trim().slice(0, 160);
      throw new Error(
        `LLM ${url} did not return JSON. First bytes: ${preview ? `"${preview}"` : '(empty body)'} — ` +
          'check that the endpoint is an OpenAI-compatible /chat/completions URL.',
      );
    }
    if (parsed.error) {
      const message = typeof parsed.error.message === 'string' ? parsed.error.message : 'unknown provider error';
      throw new Error(`LLM provider error: ${message.slice(0, 300)}`);
    }
    return parsed;
  }
}

/** What a provider connection proved it can do, stamped when the probe ran. */
export interface LlmCapabilities {
  vision: boolean;
  at: string;
}

/**
 * A request turn: plain text, or the OpenAI multimodal shape — `content` as an array of
 * `{type:'text'}` / `{type:'image_url', image_url:{url}}` parts (a data URI or an https URL).
 */
export type CompletionRequestMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'user';
      content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
    };

/** One tool invocation the model asked for. `parseError` flags a malformed arguments payload. */
export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
  parseError?: string;
}

/** The message shapes the tool loop builds (plain turns + the echoed assistant/tool turns). */
export type ChatCompletionMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | {
      role: 'tool';
      tool_call_id: string;
      content: string;
    };

interface RawToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface CompletionResponse {
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
  }>;
  error?: { message?: unknown };
  content?: unknown;
  response?: unknown;
}

/** A runaway model cannot be allowed to chain hundreds of calls in one reply. */
export const MAX_TOOL_CALLS_PER_TURN = 8;

/**
 * The visible answer out of a chat-completions response, in the shapes compatible gateways
 * actually return: a plain string, an array of content parts (`[{type:'text',text:'…'}]`), or a
 * reasoning model whose `content` stays empty while the best available text sits in
 * `reasoning_content`. Null means no answer text was present anywhere.
 */
export function extractCompletionContent(parsed: {
  choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>;
  content?: unknown;
  response?: unknown;
}): string | null {
  const message = parsed.choices?.[0]?.message;
  const content =
    flattenContentParts(message?.content) ??
    flattenContentParts(parsed.content) ??
    flattenContentParts(parsed.response);
  if (content) return content;
  const reasoning = message?.reasoning_content;
  return typeof reasoning === 'string' && reasoning.trim().length > 0 ? reasoning : null;
}

/** Join content-part arrays into one string; null when nothing textual is in them. */
function flattenContentParts(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.length > 0 ? raw : null;
  if (Array.isArray(raw)) {
    const joined = raw
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
    return joined.length > 0 ? joined : null;
  }
  return null;
}

/**
 * The chat-completions URL: the stored endpoint is the API ROOT; the call goes to
 * `<root>/chat/completions`. An operator who pasted the full path anyway gets it used as-is, so
 * both `https://api.openai.com/v1` and `https://api.openai.com/v1/chat/completions` work.
 */
function chatCompletionsUrl(endpointUrl: string): string {
  const root = endpointUrl.replace(/\/+$/, '');
  return root.endsWith('/chat/completions') ? root : `${root}/chat/completions`;
}

/** Scheme check mirroring the webhook DTO: http(s) required, no TLD requirement. */
function assertHttpUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Endpoint URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('Endpoint URL must use http or https');
  }
}
