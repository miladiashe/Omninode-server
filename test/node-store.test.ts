import { afterEach, describe, expect, it, vi } from 'vitest';
import { OmniNodeStore } from '../src/core/node-store.js';

afterEach(() => vi.restoreAllMocks());

describe('OmniNodeStore legacy serialization compatibility', () => {
  it('제거된 conversation/WRITER/CHAT 키가 있는 레거시 payload를 오류 없이 읽고 키를 제거한다', () => {
    const store = OmniNodeStore.deserialize({
      version: 1,
      conversationNodes: [],
      writerMd: 'legacy writer',
      chatMd: 'legacy chat',
    });

    expect(store.isEmpty()).toBe(true);
    expect(store).not.toHaveProperty('writerMd');
    expect(store).not.toHaveProperty('chatMd');
    const serialized = store.serializeFull();
    expect(serialized).not.toHaveProperty('conversationNodes');
    expect(serialized).not.toHaveProperty('writerMd');
    expect(serialized).not.toHaveProperty('chatMd');
  });

  it('비어 있지 않은 conversationNodes 배열은 경고 후 무시한다', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = OmniNodeStore.deserialize({
      version: 1,
      conversationNodes: [{ id: 'conv_legacy', type: 'conversation', content: 'legacy' }],
    });

    expect(store.isEmpty()).toBe(true);
    expect(store.getNode('conv_legacy')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignored 1 legacy conversationNodes'));
  });
});
