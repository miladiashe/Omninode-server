// 실 API 스모크 테스트 — smoke.config.json의 키로 각 서비스를 1회씩 실호출.
// 실행: npx tsx scripts/smoke.mts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { callLLM, type LlmConfig } from '../src/llm/client.js';
import { callEmbeddingApi, callReranker, type EmbeddingConfig } from '../src/llm/embeddings.js';
import { cosineSimilarity } from '../src/core/util.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let config: EmbeddingConfig;
try {
  config = JSON.parse(readFileSync(join(root, 'smoke.config.json'), 'utf8'));
} catch {
  console.error('❌ smoke.config.json이 없습니다. smoke.config.example.json을 복사해서 채워주세요.');
  process.exit(1);
}

const ok = (label: string, detail: string) => console.log(`✅ ${label} — ${detail}`);
const fail = (label: string, detail: string) => console.log(`❌ ${label} — ${detail}`);
const skip = (label: string, why: string) => console.log(`⏭️  ${label} — ${why} (설정 없음, 건너뜀)`);

// 1) 메인 LLM
if (config.customLlm?.apiUrl && config.customLlm?.model) {
  try {
    const t0 = Date.now();
    const res = await callLLM(
      [{ role: 'user', content: '테스트입니다. "옴니노드 서버 온라인"이라고만 답하세요.' }],
      { _config: config as LlmConfig, maxTokens: 500 },
    );
    if (res) ok('메인 LLM', `${config.customLlm.model}, ${Date.now() - t0}ms → "${res.trim().slice(0, 60)}"`);
    else fail('메인 LLM', '응답이 null (설정 확인 필요)');
  } catch (e) {
    fail('메인 LLM', (e as Error).message);
  }
} else skip('메인 LLM', 'customLlm.apiUrl/model');

// 2) 보조 LLM (_useAux — auxiliaryLlm 없으면 customLlm 폴백 경로도 겸사 검증)
if (config.customLlm?.apiUrl) {
  try {
    const t0 = Date.now();
    const res = await callLLM(
      [{ role: 'system', content: '한 단어로만 답하세요.' }, { role: 'user', content: '1+1은?' }],
      { _config: config as LlmConfig, maxTokens: 200, _useAux: true, _label: 'smoke-aux' },
    );
    const which = config.auxiliaryLlm?.apiUrl ? config.auxiliaryLlm.model : `${config.customLlm.model} (폴백)`;
    if (res) ok('보조 LLM', `${which}, ${Date.now() - t0}ms → "${res.trim().slice(0, 40)}"`);
    else fail('보조 LLM', '응답이 null');
  } catch (e) {
    fail('보조 LLM', (e as Error).message);
  }
} else skip('보조 LLM', 'customLlm.apiUrl');

// 3) 임베딩 + 코사인 유사도 새너티
if (config.embeddingEnabled && (config.embeddingEndpoint || config.customLlm?.apiUrl)) {
  try {
    const t0 = Date.now();
    const vecs = await callEmbeddingApi(['고양이가 소파에서 잔다', '고양이가 침대에서 낮잠 잔다', '증기기관의 역사'], config);
    if (vecs && vecs.length === 3) {
      const simClose = cosineSimilarity(vecs[0], vecs[1]);
      const simFar = cosineSimilarity(vecs[0], vecs[2]);
      const sane = simClose > simFar;
      ok('임베딩', `${config.embeddingModel}, dim=${vecs[0].length}, ${Date.now() - t0}ms`);
      console.log(`   유사도 새너티: 고양이↔고양이 ${simClose.toFixed(3)} ${sane ? '>' : '≯'} 고양이↔증기기관 ${simFar.toFixed(3)} ${sane ? '✅' : '⚠️ 이상함'}`);
    } else fail('임베딩', `응답 이상 (${vecs ? vecs.length + '개' : 'null'})`);
  } catch (e) {
    fail('임베딩', (e as Error).message);
  }
} else skip('임베딩', 'embeddingEnabled/endpoint');

// 4) 리랭커 (선택)
if (config.rerankerEndpoint) {
  try {
    const t0 = Date.now();
    const res = await callReranker('고양이의 수면 습관', ['고양이는 하루 16시간 잔다', '주식 시장이 하락했다'], config);
    if (res && res.length > 0) {
      const sane = res[0].index === 0;
      ok('리랭커', `${config.rerankerModel || '(모델 미지정)'}, ${Date.now() - t0}ms, top=[${res[0].index}] score=${res[0].score.toFixed(3)} ${sane ? '✅' : '⚠️ 관련 문서가 1위가 아님'}`);
    } else fail('리랭커', `응답 이상 (${res === null ? 'null' : '빈 배열'})`);
  } catch (e) {
    fail('리랭커', (e as Error).message);
  }
} else skip('리랭커', 'rerankerEndpoint');

console.log('\n스모크 테스트 종료.');
