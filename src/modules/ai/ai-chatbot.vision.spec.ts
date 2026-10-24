import { buildUserTurns, type ChatbotInboundMessage } from './ai-chatbot.service';

/**
 * How an inbound photo becomes the model's user turn: the image rides as an `image_url` content
 * part ONLY when the linked model proved vision, and every other case degrades to text the model
 * can still answer. Getting this wrong is a silent product failure: the customer's photo is
 * dropped (no vision part) or the provider refuses the whole reply (image sent to a blind model).
 */
describe('buildUserTurns', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const image = (over: Partial<ChatbotInboundMessage['media']> = {}): ChatbotInboundMessage => ({
    chatId: '628111@c.us',
    body: '',
    type: 'image',
    media: { mimetype: 'image/jpeg', data: PNG, ...over },
  });

  it('keeps a plain text message a plain text turn', () => {
    expect(buildUserTurns({ chatId: 'c', body: 'halo' }, true)).toEqual([{ role: 'user', content: 'halo' }]);
  });

  it('sends the photo beside its caption when the model has vision', () => {
    const turns = buildUserTurns(image({ ...{} }), true);
    const content = turns[0].content as unknown as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${PNG}` } });
  });

  it('puts the caption first, then the image', () => {
    const turns = buildUserTurns({ ...image(), body: 'ini produk mana?' }, true);
    expect(turns[0].content).toEqual([
      { type: 'text', text: 'ini produk mana?' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${PNG}` } },
    ]);
  });

  it('degrades to a text note for an image-blind model instead of sending the image', () => {
    const turns = buildUserTurns({ ...image(), body: 'cek ini' }, false);
    expect(turns).toHaveLength(1);
    expect(typeof turns[0].content).toBe('string');
    expect(turns[0].content).toContain('cek ini');
    expect(turns[0].content).toContain('cannot view');
  });

  it.each([
    ['omitted bytes', { omitted: true }],
    ['no data', { data: undefined }],
    ['empty mimetype', { mimetype: '' }],
  ])('annotates %s even when vision is available', (_label, over) => {
    const turns = buildUserTurns({ ...image(over), body: '' }, true);
    expect(typeof turns[0].content).toBe('string');
    expect(turns[0].content as string).toContain('cannot be viewed');
  });

  // A non-image attachment (a PDF) never reaches the model as an image part; it stays text.
  it('keeps a non-image attachment a text turn', () => {
    const turns = buildUserTurns(
      { chatId: 'c', body: 'lihat invoice ini', media: { mimetype: 'application/pdf', data: PNG } },
      true,
    );
    expect(turns).toEqual([{ role: 'user', content: 'lihat invoice ini' }]);
  });

  // The engine delivers a caption-less photo with an empty body; the note must stand alone.
  it('answers a caption-less photo with the note alone', () => {
    expect(buildUserTurns(image(), false)[0].content).toBe('[The customer sent an image this model cannot view.]');
  });
});
