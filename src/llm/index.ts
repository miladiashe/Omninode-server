// LLM 레이어 진입점. Phase 1에서 주입식으로 남겨둔 지점(updateUtilityScoresLLM 등)에
// 꽂을 준비된 의존성 묶음을 제공한다.
import type { LlmDeps } from '../core/node-store.js';
import { callLLM, type CallLlmOptions } from './client.js';
import { DEFAULT_PROMPTS } from './prompts.js';

export * from './client.js';
export * from './embeddings.js';
export { DEFAULT_PROMPTS } from './prompts.js';

export const llmDeps: LlmDeps = {
  callLLM: (messages, opts) => callLLM(messages, opts as unknown as CallLlmOptions),
  defaultPrompts: DEFAULT_PROMPTS,
};
