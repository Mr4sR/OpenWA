import 'reflect-metadata';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { UpdateAiChatbotDto } from './ai-chatbot.dto';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';

/**
 * The Chats/AI Integration dashboard saves a chatbot with `ragModelId: null` and `persona: null`
 * whenever the operator leaves those optional fields empty. Under the global validation contract
 * (`enableImplicitConversion: true`), `@ValidateIf(o => o.x !== undefined)` still runs the string
 * validators on an explicit `null` — implicit conversion turns `null` into the string `"null"` —
 * which made every such save a 400. The update DTO must skip validators for explicit nulls (the
 * service turns them into "detach"/"clear"), while still refusing non-string garbage.
 */
describe('UpdateAiChatbotDto under the global validation contract', () => {
  const buildPipe = () =>
    new ValidationPipe({ ...GLOBAL_VALIDATION_OPTIONS, disableErrorMessages: false });
  const meta = { type: 'body' as const, metatype: UpdateAiChatbotDto, data: '' };

  it('accepts the dashboard save with ragModelId and persona cleared to null', async () => {
    const out = await buildPipe().transform(
      {
        name: 'Test',
        llmModelId: '112eb71a-bfe8-4018-afda-24e4c60a8bab',
        ragModelId: null,
        persona: null,
        replyGroups: false,
        enabled: true,
      },
      meta,
    );
    expect(out).toMatchObject({ ragModelId: null, persona: null, replyGroups: false });
  });

  it('accepts null as detach/clear for each optional field independently', async () => {
    await expect(buildPipe().transform({ ragModelId: null }, meta)).resolves.toMatchObject({ ragModelId: null });
    await expect(buildPipe().transform({ persona: null }, meta)).resolves.toMatchObject({ persona: null });
    await expect(buildPipe().transform({ persona: '' }, meta)).resolves.toMatchObject({ persona: '' });
  });

  it('passes llmModelId null through validation (the service owns the required-ref 400)', async () => {
    await expect(buildPipe().transform({ llmModelId: null }, meta)).resolves.toMatchObject({ llmModelId: null });
  });

  it('coerces scalars like every DTO under the global contract, but still refuses dangerous content', async () => {
    // Implicit conversion turns 42 into "42" — the app-wide contract, not this DTO's business.
    await expect(buildPipe().transform({ name: 42 }, meta)).resolves.toMatchObject({ name: '42' });
    await expect(buildPipe().transform({ persona: 'a\u0000b' }, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(buildPipe().transform({ persona: 'x'.repeat(32_001) }, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(buildPipe().transform({ ragModelId: 7 }, meta)).rejects.toBeInstanceOf(BadRequestException);
  });

});
