// 서버 설정 저장소. 원본 DEFAULT_CONFIG (L96–179)를 이식하고,
// DB config 테이블의 사용자 설정을 깊은 병합으로 얹는다.
// 원본의 pluginStorage 기반 getConfig()/saveUserConfig를 대체한다.
import type Database from 'better-sqlite3';
import type { EmbeddingConfig } from './llm/embeddings.js';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_AUX_MAX_TOKENS } from './llm/client.js';

const MERGE_VECTOR_THRESHOLD = 0.85;
const NODE_TYPE_KEYS = ['lore', 'extraLore', 'longTermMemory', 'communitySummary'] as const;

// 파이프라인·에이전트가 참조하는 전체 설정 형태 (원본 DEFAULT_CONFIG와 동일 키)
export type OmniConfig = EmbeddingConfig & {
  shortTermWindow: number;
  entityNameLanguage: string;
  useOnlyAssistantRole: boolean;
  mergeEnabled: boolean;
  memrlMode: 'off' | 'embedding' | 'llm'; // MemRL feedback: disabled, embedding similarity, or auxiliary-LLM judgement
  useGliner: boolean;
  keywordRecentMessages: number;
  mergeNameThreshold: number;
  mergeVectorThreshold: number;
  nodeEditPromptBlocks: unknown;
  edgeHalfLife: number;
  relationshipWeights: Record<string, number>;
  hydePrompt: string | null;
  communitySummaryPrompt: string | null;
  superCommunityPrompt: string | null;
  memrlSystemPrompt: string | null;
  memrlUserPromptTemplate: string | null;
  mdAtlasEnabled: boolean;
  rrfK: number;
  autodreamEnabled: boolean;
  autodreamAutoInterval: number;
  autodreamAutoMinMessages: number;
  worldSimEnabled: boolean;
  worldSimInterval: number;
  worldSimMaxNodes: number;
  worldSimPrompt: string | null;
  reevalCompactionEnabled: boolean;       // [Updated] 노트 누적 노드를 하나의 정합 서술로 재작성 (dream 태스크 5)
  reevalCompactionMinNotes: number;       // 컴팩션 발동 최소 노트 수
  reevalCompactionMaxPerRun: number;      // dream 1회당 컴팩션 노드 상한 (저빈도 유지)
  compactionPrompt: string | null;
  loreNoteCompactionPrompt: string | null;
  loreNoteCompactionMaxRatio: number;    // 로어 노트 병합 통과 기준 — 병합본이 노트 합계의 이 비율 이하일 때만 접합 (1.0=길이만 안 늘면 허용, 0=무제한 — 길어져도 병합). 역할은 순증 방어이지 병합 가치 판별이 아님 — 성실한 병합도 85~93%가 실측 정상 범위(비결정성 ±8%)라 과하게 조이면 좋은 병합을 거부함 (HANDOFF §E 해석 변천 참조)
  typeDiversityDecay: Record<string, number> | null;
  injectionDebugEnabled: boolean;         // 디버그 전용: 활성화 시 낙선 후보를 기록해 주입 레코드 크기가 커짐
  glinerEndpoint: string;
  glinerApiKey: string;
  glinerLabels: string[];
  customPrompt: string;
  hydeCacheMax: number;
  llmTimeoutMs: number; // LLM/임베딩/리랭커 fetch 타임아웃(ms) — 설정 페이지 고급 JSON으로 조절
  // 원문 발췌 설정. 기본값은 beta27 원작자 값
  dynamicExcerptEnabled: boolean;
  dynamicExcerptBudgetShare: number;      // 노드 예산 중 발췌 총량 상한 비율
  dynamicExcerptImportanceBase: number;   // 이 중요도 이상의 LTM만 발췌 동반
  dynamicExcerptMaxCharsPerMsg: number;   // 발췌 메시지당 문자 상한
  maxNodeContentChars: number;            // 노드 내용 문자 캡 (0=무제한, 로어는 항상 전문) — 원본 3000의 설정화
  ltmMaxNodesPerBatch: number;            // 에이전트 배치당 노드 수 예산 (0=무제한=원본 폭주 지시)
  agentTwoPassRelationships: boolean;     // 관계를 2차 호출로 분리 (절단 시 관계 유실 방지)
  directKeyMatchEnabled: boolean;         // 로어북 키 직격 substring 매칭 (원작 이탈 — LLM 키워드 추출 보완)
  keywordRevivalEnabled: boolean;         // 로컬 키워드로 재등장한 활성 로어를 활성도 30까지 소생
  communitySummaryMemberChars: number;    // 커뮤니티 요약 시 멤버당 읽는 문자 수 (0=전문 — 원작은 15멤버×200자)
  maxCommunitySize: number;               // 군집 최대 멤버 수 — 초과 시 재귀 분할 (0=원작 무제한, 메가 블롭 허용)
  copyDetectEnabled: boolean;             // 챗 복사 자동 감지 — 빈 그래프+긴 히스토리면 기존 로그와 대조해 그래프 승계
  copyDetectMinPrefix: number;            // 복사 판정 최소 공통 프리픽스(메시지 수) — 첫 메시지는 인사말이라 짧은 일치는 무의미
};

export const DEFAULT_CONFIG: OmniConfig = {
  shortTermWindow: 9,
  customLlm: {
    apiFormat: 'auto',
    apiUrl: '',
    apiKey: '',
    model: '',
    awsRegion: '',
    gcpRegion: 'global',
    bedrockEndpoint: 'messages',
    temperature: 0.3,
    maxTokens: DEFAULT_MAX_TOKENS,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    extraHeaders: {},
    extraBody: {},
    cotTokenLimit: 0,
    manualCoT: false,
  },
  auxiliaryLlm: {
    apiFormat: 'auto',
    apiUrl: '',
    apiKey: '',
    model: '',
    awsRegion: '',
    gcpRegion: 'global',
    bedrockEndpoint: 'messages',
    temperature: 0.2,
    maxTokens: DEFAULT_AUX_MAX_TOKENS,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    extraHeaders: {},
    extraBody: {},
  },
  embeddingEnabled: false,
  embeddingEndpoint: '',
  embeddingModel: 'text-embedding-3-small',
  embeddingApiKey: '',
  entityNameLanguage: '',
  rpm: 0,
  maxRetries: 1, // 기본 1 — 재시도는 곧 비용 (사용자 실사용 검증값, 2026-08-28 기본값 정책)
  llmTimeoutMs: 180000, // LLM/임베딩 fetch 타임아웃 — 게이트웨이 행 방어 (서버판 추가)
  dynamicExcerptEnabled: true,
  dynamicExcerptBudgetShare: 0.25,
  dynamicExcerptImportanceBase: 4,
  dynamicExcerptMaxCharsPerMsg: 400,
  maxNodeContentChars: 12000, // 원본 3000 → 상향 (주입량은 토큰 예산이 통제)
  ltmMaxNodesPerBatch: 32, // 실측: 무제한 시 deepseek 75노드/8msg 절단 폭발
  agentTwoPassRelationships: true,
  directKeyMatchEnabled: true, // 에릭 프로필 사건(2026-08-02): LLM 추출이 이름을 놓쳐 로어 검색 탈락
  keywordRevivalEnabled: true, // 시든 로어의 직격 재등장이 활성도 배수에 막히는 죽음의 계곡 방지 (2026-08-08)
  communitySummaryMemberChars: 0, // 0=전문 (2026-08-03 사용자 결정 — 원작 slice(0,15)×200자는 76멤버 중 61멤버 0자 반영)
  maxCommunitySize: 25, // 연속 서사 메가 블롭(T100 실측 85노드) 분할 — beta27 계층 도입의 전제 조건이기도 (2026-08-03 사용자 승인)
  copyDetectEnabled: true, // HANDOFF §G [필수] — 일반 사용자는 챗 복사 시 기억 유지를 기대 (2026-08-04 자동 감지로 결정)
  copyDetectMinPrefix: 8,
  excludeUserEmbedding: false,
  hydeEnabled: false,
  hydeCacheMax: 200,
  customPrompt: '',
  useOnlyAssistantRole: false,
  mergeEnabled: true,
  memrlMode: 'embedding', // 'off' | 'embedding' (default) | 'llm'
  useGliner: false, // 기본 false — 엔드포인트 없으면 어차피 LLM 폴백(버그6 실효 판정)이라 스위치 상태를 실동작과 일치시킴
  keywordRecentMessages: 3, // number of recent messages to use for keyword extraction
  rerankerEndpoint: '', // Jina/Cohere-compatible reranker API
  rerankerModel: '',
  rerankerApiKey: '',
  vertexAiServiceAccountJson: '',
  mergeNameThreshold: 0.7,
  mergeVectorThreshold: MERGE_VECTOR_THRESHOLD,
  nodeEditPromptBlocks: null,
  edgeHalfLife: 100, // turns for relationship edge weight to halve in Temporal PPR
  relationshipWeights: {
    causes: 0.7,
    enables: 0.6,
    prevents: 0.5,
    contradicts: 0.5,
    develops: 0.6,
    related: 0.3,
    parent: 0.8,
    default: 0.5,
  },
  hydePrompt: null,
  communitySummaryPrompt: null,
  superCommunityPrompt: null,
  memrlSystemPrompt: null,
  memrlUserPromptTemplate: null,
  mdAtlasEnabled: true,
  rrfK: 60,
  autodreamEnabled: true,
  autodreamAutoInterval: 60,
  autodreamAutoMinMessages: 4,
  worldSimEnabled: true,
  worldSimInterval: 3,
  worldSimMaxNodes: 5,
  worldSimPrompt: null,
  reevalCompactionEnabled: true, // 2026-08-05 게이트 첫 도달(노트 3개 노드 2개)로 구현 — 사용자 아이디어(2026-08-01 메모)
  reevalCompactionMinNotes: 3,
  reevalCompactionMaxPerRun: 2,
  compactionPrompt: null,
  loreNoteCompactionPrompt: null,
  loreNoteCompactionMaxRatio: 0.95, // 실측 조정 2026-08-10: 0.85는 성실 병합(리수진 재현 85.5%)도 거부 — 순증만 막는 선
  chatRegexFilters: [],
  typeDiversityDecay: null,
  injectionDebugEnabled: false,
  glinerEndpoint: '',
  glinerApiKey: '',
  glinerLabels: ['person', 'place', 'time', 'organization', 'object', 'event', 'emotion', 'concept'],
};

function deepMerge<T extends Record<string, any>>(target: T, source: Record<string, any>): T {
  const out: Record<string, any> = { ...target };
  for (const key of Object.keys(source)) {
    const s = source[key];
    const t = out[key];
    if (s && typeof s === 'object' && !Array.isArray(s) && t && typeof t === 'object' && !Array.isArray(t)) {
      out[key] = deepMerge(t, s);
    } else if (s !== undefined) {
      out[key] = s;
    }
  }
  return out as T;
}

export class ConfigStore {
  constructor(private db: Database.Database) {}

  // scope: 'global' 또는 채팅별 오버라이드('chat:<chatKey>' — Phase 8 UI에서 활용)
  load(scope = 'global'): OmniConfig {
    const row = this.db.prepare('SELECT json FROM config WHERE scope = ?').get(scope) as { json: string } | undefined;
    const user: Record<string, any> = row ? JSON.parse(row.json) : {};
    if (user.mdFeaturesEnabled === false) user.mdAtlasEnabled = false;
    delete user.mdWriterEnabled;
    delete user.mdChatEnabled;
    delete user.mdFeaturesEnabled;
    const config = deepMerge(DEFAULT_CONFIG, user);
    if (config.typeDiversityDecay) {
      config.typeDiversityDecay = Object.fromEntries(
        NODE_TYPE_KEYS
          .filter(key => config.typeDiversityDecay?.[key] !== undefined)
          .map(key => [key, config.typeDiversityDecay![key]]),
      );
    }
    return config;
  }

  save(userConfig: Record<string, unknown>, scope = 'global') {
    this.db.prepare('INSERT OR REPLACE INTO config (scope, json) VALUES (?, ?)')
      .run(scope, JSON.stringify(userConfig));
  }

  // 저장된 사용자 오버라이드 원본 (기본값 미병합 — 설정 UI용)
  loadRaw(scope = 'global'): Record<string, unknown> {
    const row = this.db.prepare('SELECT json FROM config WHERE scope = ?').get(scope) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : {};
  }
}
