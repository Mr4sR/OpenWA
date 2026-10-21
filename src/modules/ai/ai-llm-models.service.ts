import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

/** Wall-clock ceiling of one completion call (the chatbot reply path shares it). */
export const LLM_REQUEST_TIMEOUT_MS = 120_000;

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

  async create(dto: CreateAiLlmModelDto): Promise<AiLlmModel> {
    const existing = await this.repository.count();
    const max = this.configService?.get<number>('ai.llmModelsMax', AI_LLM_MODELS_MAX) ?? AI_LLM_MODELS_MAX;
    if (max > 0 && existing >= max) {
      throw new BadRequestException(
        `LLM model limit reached (${existing}/${max}); delete one before adding another`,
      );
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
      name: dto.name,
      endpointUrl: dto.endpointUrl.replace(/\/+$/, ''),
      apiKey: dto.apiKey ?? '',
      model: dto.model ?? '',
      persona: dto.persona ?? null,
      parameters: sanitizeLlmParameters(dto.parameters ?? null),
      headers: Object.keys(dto.headers ?? {}).length > 0 ? sanitizeHeaderMap(dto.headers) : {},
      enabled: dto.enabled ?? true,
    });
    const saved = await this.repository.save(model);
    void this.audit.logInfo(AuditAction.AI_LLM_MODEL_CREATED, {
      metadata: { llmModelId: saved.id, llmModelName: saved.name },
    });
    return saved;
  }

  async findAll(): Promise<AiLlmModel[]> {
    return this.repository.find({ order: { createdAt: 'ASC', id: 'ASC' } });
  }

  async findOne(id: string): Promise<AiLlmModel> {
    const model = await this.repository.findOne({ where: { id } });
    if (!model) {
      throw new NotFoundException(`LLM model ${id} not found`);
    }
    return model;
  }

  async update(id: string, dto: UpdateAiLlmModelDto): Promise<AiLlmModel> {
    const model = await this.findOne(id);
    if (dto.name !== undefined) model.name = dto.name;
    if (dto.endpointUrl !== undefined) {
      assertHttpUrl(dto.endpointUrl);
      model.endpointUrl = dto.endpointUrl.replace(/\/+$/, '');
    }
    if (dto.apiKey !== undefined) model.apiKey = dto.apiKey;
    if (dto.model !== undefined) model.model = dto.model;
    if (dto.persona !== undefined) model.persona = dto.persona;
    if (dto.parameters !== undefined) model.parameters = sanitizeLlmParameters(dto.parameters);
    if (dto.headers !== undefined) model.headers = sanitizeHeaderMap(dto.headers);
    if (dto.enabled !== undefined) model.enabled = dto.enabled;
    const saved = await this.repository.save(model);
    void this.audit.logInfo(AuditAction.AI_LLM_MODEL_UPDATED, {
      metadata: { llmModelId: saved.id, llmModelName: saved.name },
    });
    return saved;
  }

  async remove(id: string): Promise<void> {
    const model = await this.findOne(id);
    await this.repository.remove(model);
    void this.audit.logInfo(AuditAction.AI_LLM_MODEL_DELETED, {
      metadata: { llmModelId: id, llmModelName: model.name },
    });
  }

  /** Record connection-test diagnostics. Best-effort: never wedges the test response. */
  async recordStatus(id: string, status: { ok: boolean; error?: string }): Promise<void> {
    try {
      await this.repository.update(
        { id },
        {
          lastStatus: { ok: status.ok, at: new Date().toISOString(), ...(status.error ? { error: status.error } : {}) },
          lastTestedAt: new Date(),
        },
      );
      void this.audit.logInfo(AuditAction.AI_LLM_MODEL_TESTED, {
        metadata: { llmModelId: id, ok: status.ok, ...(status.error ? { error: status.error.slice(0, 200) } : {}) },
      });
    } catch (error) {
      this.logger.warn('Failed to record LLM connection status', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * One chat completion. `messages` arrives pre-built by the caller (persona, RAG context,
   * history); this only adds the endpoint, the key and the sampling parameters.
   */
  async complete(
    model: AiLlmModel,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ): Promise<string> {
    const body: Record<string, unknown> = { model: model.model || undefined, messages };
    const parameters = sanitizeLlmParameters(model.parameters);
    if (parameters) {
      if (parameters.temperature !== undefined) body.temperature = parameters.temperature;
      if (parameters.maxTokens !== undefined) body.max_tokens = parameters.maxTokens;
      if (parameters.topP !== undefined) body.top_p = parameters.topP;
      if (parameters.stop !== undefined) body.stop = parameters.stop;
    }
    let answer: string;
    try {
      answer = await withSafeFetch(
        `${model.endpointUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
            ...sanitizeHeaderMap(model.headers),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
        },
        async (response: undiciResponse) => {
          if (!response.ok) {
            const detail = (await response.text()).slice(0, 300);
            throw new Error(`LLM HTTP ${response.status}: ${detail}`);
          }
          // Responses are small JSON docs; the byte cap turns a runaway provider into an error
          // instead of an unbounded buffer.
          const reader = response.body;
          if (!reader) throw new Error('LLM returned an empty body');
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
      throw new Error(redactSsrfError(error));
    }

    let parsed: {
      choices?: Array<{ message?: { content?: unknown } }>;
      error?: { message?: unknown };
    };
    try {
      parsed = JSON.parse(answer) as typeof parsed;
    } catch {
      throw new Error('LLM returned a non-JSON body');
    }
    if (parsed.error) {
      const message = typeof parsed.error.message === 'string' ? parsed.error.message : 'unknown provider error';
      throw new Error(`LLM provider error: ${message.slice(0, 300)}`);
    }
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('LLM returned no completion content');
    }
    return content;
  }
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
