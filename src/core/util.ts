// 원본 omninode-beta21-fix5-selffix.js에서 이식한 공용 유틸.
// 로직은 원본과 동일하게 유지한다 (차분 테스트로 검증).
// 원본 위치: L13(LOG_PREFIX), L51–84(관계 타입/보정), L1072–1170(JSON/토큰/ID/해시),
//            L2587(cosineSimilarity), L8467(_normalizeCompactTs)

export const LOG_PREFIX = '[OMNINODE]';

const _DEBUG = process.env.OMNINODE_DEBUG === '1';
export function _dbg(...args: unknown[]): void {
  if (_DEBUG) console.log(...args);
}

// ── Canonical Relationship Types ──
export const CANONICAL_REL_TYPES = ['causes', 'enables', 'prevents', 'contradicts', 'develops', 'related', 'parent'] as const;
const CANONICAL_REL_SET = new Set<string>(CANONICAL_REL_TYPES);
const DIRECTIONAL_REL_TYPES = new Set(['causes', 'enables', 'prevents', 'parent']);

export function normalizeRelType(type: string | null | undefined): string {
  if (!type) return 'related';
  const t = type.toLowerCase().trim();
  return CANONICAL_REL_SET.has(t) ? t : 'related';
}

export function defaultDirectionForType(type: string): string {
  return DIRECTIONAL_REL_TYPES.has(type) ? 'uni' : 'bi';
}

export function clampStrength(v: unknown): number {
  const n = parseInt(v as string, 10);
  if (isNaN(n)) return 3;
  return Math.max(1, Math.min(5, n));
}

export const isLoreType = (t: string) => t === 'lore' || t === 'extraLore' || t === 'communitySummary';
export const isMemoryType = (t: string) => t === 'longTermMemory';

export const NODE_IMPORTANCE_RANGE: Record<string, [number, number]> = {
  extraLore: [3, 5],
  longTermMemory: [1, 5],
  communitySummary: [3, 5],
};

export function _evictOldest(map: Map<unknown, unknown>, maxSize: number): void {
  while (map.size > maxSize) map.delete(map.keys().next().value);
}

// ── Robust JSON Parse (small-model output recovery) ──
// 절단 JSON 복구 (진화 트랙 D2 — beta27 _repairJson(L4425)에서 착안하되 목적이 다름):
// beta27은 소형 모델의 문법 오류 복구(작은따옴표 치환 등 — 본문에 아포스트로피가 흔한
// 서사 텍스트엔 파괴적이라 미채택), 우리는 "출력 캡에서 잘린 대형 JSON"에서 완성된
// 요소까지를 살려내는 것이 목적. 문자열/이스케이프 상태를 추적하며 괄호 스택을 쌓고,
// 마지막으로 완성된 값 직후로 잘라 남은 괄호를 닫는다 (60노드 중 59개 구조 시 59개 구제).
export function repairTruncatedJson(raw: string | null | undefined): unknown | null {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // 마크다운 펜스 제거
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  const first = (firstArr >= 0 && (firstObj < 0 || firstArr < firstObj)) ? firstArr : firstObj;
  if (first < 0) return null;
  s = s.substring(first);

  const stack: string[] = [];
  let inString = false, escape = false;
  let lastCompleteEnd = -1;      // 마지막으로 값이 완성된 직후 위치
  let stackAtLastComplete = '';  // 그 시점의 열린 괄호들
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = false; lastCompleteEnd = i + 1; stackAtLastComplete = stack.join(''); }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      stack.pop();
      lastCompleteEnd = i + 1;
      stackAtLastComplete = stack.join('');
      if (stack.length === 0) break; // 완결 — 이하는 잔여 텍스트
    }
  }

  const candidates: string[] = [];
  if (stack.length === 0 && lastCompleteEnd > 0) {
    candidates.push(s.substring(0, lastCompleteEnd));
  } else if (lastCompleteEnd > 0) {
    // 절단됨 — 마지막 완성 값까지 자르고, 그 시점에 열려 있던 괄호를 역순으로 닫는다
    let cut = s.substring(0, lastCompleteEnd).replace(/,\s*$/, '');
    const closers = [...stackAtLastComplete].reverse().map(c => (c === '{' ? '}' : ']')).join('');
    candidates.push(cut + closers);
    // 잘린 마지막 요소(불완전 객체)를 통째로 버리는 변형도 시도
    const lastObjStart = cut.lastIndexOf('{');
    const lastComma = cut.lastIndexOf(',', lastObjStart);
    if (lastObjStart > 0 && lastComma > 0 && stackAtLastComplete.endsWith('{')) {
      const closers2 = [...stackAtLastComplete.slice(0, -1)].reverse().map(c => (c === '{' ? '}' : ']')).join('');
      candidates.push(cut.substring(0, lastComma) + closers2);
    }
  }
  for (const c of candidates) {
    try { return JSON.parse(c.replace(/,\s*([}\]])/g, '$1')); } catch { /* 다음 후보 */ }
  }
  return null;
}


// GLM 5.2 실측 (2026-08-31, agent-parse-fail 덤프): 생각 모델이 JSON 문자열 값 안에
// 이스케이프 안 된 생 줄바꿈/탭을 넣어 보냄 — 규격 위반이라 JSON.parse가 즉사한다.
// 문자열 리터럴 내부의 생 제어문자만 이스케이프한다 (토큰 사이 줄바꿈은 합법이므로 보존).
// 합법 JSON은 문자열 안에 생 제어문자가 있을 수 없어, 이 변환은 합법 입력을 바꾸지 않는다.
function _escapeCtrlInJsonStrings(s: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

export function robustParseJSON(raw: string | null | undefined): unknown {
  if (!raw) return null;
  let str = raw.trim();
  str = str.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/im, '');
  try { return JSON.parse(str); } catch { /* continue */ }
  try { return JSON.parse(_escapeCtrlInJsonStrings(str)); } catch { /* continue */ }
  const firstBrace = str.indexOf('{');
  const firstBracket = str.indexOf('[');
  const lastBrace = str.lastIndexOf('}');
  const lastBracket = str.lastIndexOf(']');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return JSON.parse(str.substring(firstBrace, lastBrace + 1)); } catch { /* continue */ }
    try { return JSON.parse(_escapeCtrlInJsonStrings(str.substring(firstBrace, lastBrace + 1))); } catch { /* continue */ }
  }
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try { return JSON.parse(str.substring(firstBracket, lastBracket + 1)); } catch { /* continue */ }
    try { return JSON.parse(_escapeCtrlInJsonStrings(str.substring(firstBracket, lastBracket + 1))); } catch { /* continue */ }
  }

  const candidates: string[] = [];
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(str.substring(firstBrace, lastBrace + 1));
  if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(str.substring(firstBracket, lastBracket + 1));
  candidates.push(str);

  for (const candidate of candidates) {
    let fixed = candidate;
    fixed = fixed.replace(/\/\/[^\n]*/g, '');
    fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');
    fixed = fixed.replace(/,\s*([}\]])/g, '$1');
    fixed = fixed.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner: string) => `"${inner.replace(/"/g, '\\"')}"`);
    fixed = fixed.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
    fixed = fixed.replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
    // eslint-disable-next-line no-control-regex
    fixed = fixed.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    try { return JSON.parse(fixed); } catch { /* continue */ }
  }

  const nodesMatch = str.match(/"nodes"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
  if (nodesMatch) {
    try {
      const nodes = JSON.parse(nodesMatch[1].replace(/,\s*([}\]])/g, '$1'));
      if (Array.isArray(nodes) && nodes.length > 0) {
        return { nodes, relationships: [] };
      }
    } catch { /* continue */ }
  }

  console.log(`${LOG_PREFIX} robustParseJSON failed on: ${str.substring(0, 200)}`);
  return null;
}

// ── AI 사고 블록 제거 (2026-08-05, 사용자 결정) ──
// Risu가 메시지에 저장하는 추론 블록: <Thoughts>…</Thoughts> (고정 태그) 및
// <!-- pm:think… --> 마커. 기억 처리(발췌·LTM 배치·요약·키워드·임베딩) 입력에서
// AI의 메타 추론이 서사 기억으로 새는 것을 막는다. 저장(messages 테이블)은 원문
// 유지 — 소비 시점에만 제거 (복사 감지의 해시 대조가 원문 기준이므로).
export function stripThoughtBlocks(text: string): string {
  if (!text) return text;
  return text
    .replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, '')
    .replace(/<!--\s*pm:think[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Token Estimation (CJK-aware) ──
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g) || []).length;
  const nonCjkLen = text.length - cjkCount;
  return Math.ceil(nonCjkLen / 4 + cjkCount / 1.5);
}

export function estimateMessagesTokens(messages: Array<{ content: unknown }>): number {
  let total = 0;
  for (const msg of messages) {
    total += 4; // role overhead
    total += estimateTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
  }
  return total;
}

// ── Unique ID Generator ──
let _idCounter = 0;
export function generateId(prefix = 'node'): string {
  return `${prefix}_${Date.now()}_${++_idCounter}_${Math.random().toString(36).substring(2, 6)}`;
}

// ── Simple Content Hash ──
export function contentHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

// ── Cosine Similarity ──
export function cosineSimilarity(a: ArrayLike<number> | null | undefined, b: ArrayLike<number> | null | undefined): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Compact Timestamp (YYMMDDHHmm) ──
export function _normalizeCompactTs(ts: unknown): string | null {
  if (ts === null || ts === undefined) return null;
  const s = String(ts).trim();
  if (!s) return null;
  if (/^\d{10}$/.test(s)) return s;
  const legacyBracket = s.match(/\[(\d{10})\]/);
  if (legacyBracket) return legacyBracket[1];
  const plainTenDigits = s.match(/\b(\d{10})\b/);
  if (plainTenDigits) return plainTenDigits[1];
  return null;
}

export function _extractCompactTs(ts: unknown): string {
  return _normalizeCompactTs(ts) || '';
}

// Parse YYMMDDHHMM string to minutes since 2000-01-01 for consistent arithmetic
export function _compactTsToMinutes(ts: string): number {
  if (!ts || ts.length !== 10) return NaN;
  const yy = parseInt(ts.slice(0, 2), 10);
  const mm = parseInt(ts.slice(2, 4), 10) - 1;
  const dd = parseInt(ts.slice(4, 6), 10);
  const hh = parseInt(ts.slice(6, 8), 10);
  const mi = parseInt(ts.slice(8, 10), 10);
  const d = new Date(2000 + yy, mm, dd, hh, mi);
  if (isNaN(d.getTime())) return NaN;
  return d.getTime() / 60000; // minutes
}

export function _compactNow(): string {
  const d = new Date();
  const YY = String(d.getFullYear()).slice(-2);
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${YY}${MM}${DD}${hh}${mm}`;
}
