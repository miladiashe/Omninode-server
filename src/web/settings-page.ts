// 웹 설정 페이지 — 프레임워크 없는 단일 HTML.
// 페이지 자체는 무인증(데이터 없음), 실제 읽기/쓰기는 Bearer 토큰으로 /api/config 호출.
// 토큰은 URL 프래그먼트(#token=...)로 전달받아 자동 입력 (서버 로그에 남지 않음).
// Phase 8a (PHASE8-UI.md §2): 설정 전수 폼 노출 — 모바일 우선 구조 (2026-08-06):
//   상단 고정 칩 탭바(그룹 6개) + 하단 고정 액션바(저장/상태). 탭은 표시 전환만 하고
//   DOM은 전부 유지 — "여러 탭 수정 후 저장 한 번" 의미론 보존.
// 미노출 잔류(고급 JSON): nodeEditPromptBlocks·cot.
import { DEFAULT_PROMPTS } from '../llm/prompts.js';
import { THEME_CSS, THEME_SCRIPT } from './theme.js';

// 프롬프트 편집기: 폼 id → (config 키, 기본값 텍스트, 라벨)
const PROMPT_DEFS: Array<[string, string, string]> = [
  ['p_custom', 'customPrompt', '에이전트 커스텀 프롬프트 (시스템 프롬프트 앞에 추가)'],
  ['p_comm', 'communitySummaryPrompt', '커뮤니티 요약 (관련 기억 묶음)'],
  ['p_super', 'superCommunityPrompt', '슈퍼 커뮤니티 개요 (챕터 상위 요약)'],
  ['p_ws', 'worldSimPrompt', '월드심 (화면 밖 세계 진행)'],
  ['p_compact', 'compactionPrompt', '기억 정정 정리 (컴팩션)'],
  ['p_lore_compact', 'loreNoteCompactionPrompt', '로어 정정 메모 병합 (컴팩션)'],
  ['p_hyde', 'hydePrompt', '가상 답변 검색 (HyDE)'],
  ['p_memrl_s', 'memrlSystemPrompt', '기억 유용성 평가 — 시스템 (MemRL)'],
  ['p_memrl_u', 'memrlUserPromptTemplate', '기억 유용성 평가 — 템플릿 (MemRL)'],
];
const PROMPT_DEFAULTS_JSON = JSON.stringify({
  p_custom: '',
  p_comm: DEFAULT_PROMPTS.communitySummary,
  p_super: DEFAULT_PROMPTS.superCommunity,
  p_ws: DEFAULT_PROMPTS.worldSim,
  p_compact: DEFAULT_PROMPTS.compaction,
  p_lore_compact: DEFAULT_PROMPTS.loreNoteCompaction,
  p_hyde: DEFAULT_PROMPTS.hyde,
  p_memrl_s: DEFAULT_PROMPTS.memrlSystem,
  p_memrl_u: DEFAULT_PROMPTS.memrlUserTemplate,
});
const PROMPT_CARDS_HTML = PROMPT_DEFS.map(([id, , label]) => `
<details class="sec panel" data-g="prompts">
<summary>${label} <span class="badge pbadge" id="${id}_badge">기본값</span></summary>
<textarea id="${id}" spellcheck="false" style="min-height:120px"></textarea>
<div class="row">
  <button type="button" class="secondary inline" data-preset="${id}">기본값으로 롤백</button>
</div>
</details>`).join('\n');

export const SETTINGS_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>${THEME_SCRIPT}</script>
<title>OmniNode Server 설정</title>
<style>
${THEME_CSS}
  body { padding-bottom: 112px; }
  h1 { margin: 8px 0 12px; }
  label { display: block; margin-top: 12px; }
  input[type=text], input[type=password], input[type=number], textarea, select {
    width: 100%; margin-top: 4px;
  }
  textarea { min-height: 180px; font-size: 0.8rem; }
  .row { display: flex; gap: 12px; } .row > div { flex: 1; }
  .chk { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .chk label { margin: 0; }
  button.inline { margin-top: 8px; padding: 4px 12px; white-space: nowrap; flex: 0 0 auto; }
  details.sec { margin-top: 12px; }
  details.sec > summary { min-height: 36px; cursor: pointer; padding: 8px 0; font-size: 1.05rem; font-weight: 700; line-height: 1.35; }
  details.sec > summary .hint { margin-left: 8px; }
  .badge { margin-left: 8px; vertical-align: middle; border-color: var(--accent); color: var(--accent); }
  .badge.custom { background: var(--accent); color: var(--accent-contrast); }
  .pill { margin-left: 8px; }
  .rxrow { margin-top: 8px; padding: 8px 12px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-deep); }
  .grid4 { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 8px; margin-top: 8px; }
  .download-hint, .prompt-hint, .empty-hint { color: var(--text-faint); font-size: 0.74rem; font-weight: 400; line-height: 1.4; }
  .download-hint, .prompt-hint { margin-top: 12px; }
  #rx_add { margin-top: 12px; }
  /* 상단 고정 칩 탭바 — 모바일 우선: 가로 스크롤 */
  #tabs { position: sticky; top: 0; z-index: 10; background: var(--bg); display: flex; gap: 8px;
    overflow-x: auto; padding: 8px 0; margin: 0 -16px; padding-left: 16px; padding-right: 16px;
    border-bottom: 1px solid var(--border); -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  #tabs::-webkit-scrollbar { display: none; }
  .tab { flex: 0 0 auto; margin: 0; }
  /* 하단 고정 액션바 — 엄지 존 */
  #actionbar { position: fixed; bottom: 0; left: 0; right: 0; background: var(--bg);
    border-top: 1px solid var(--border); padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); z-index: 10; }
  #actionbar .inner { max-width: 960px; margin: 0 auto; }
  #actionbar .row { align-items: center; }
  #status { min-height: 20px; margin-top: 8px; font-size: 0.8rem; font-weight: 500; line-height: 1.45; }
  [data-g] { display: none; }
  @media (min-width: 60rem) {
    #tabs { margin-right: -24px; margin-left: -24px; padding-right: 24px; padding-left: 24px; }
    #actionbar { padding-right: 24px; padding-left: 24px; }
  }
</style>
</head>
<body>
<h1>OmniNode Server 설정 <span class="pill" id="ver"></span></h1>
<nav class="topnav" aria-label="주요 메뉴">
  <span class="current" aria-current="page">⚙️ 설정</span>
  <a href="/dashboard">📊 대시보드</a>
  <a href="/graph">🕸️ 그래프</a>
  <a href="/injection">💉 주입 뷰어</a>
  <button type="button" class="theme-toggle" aria-label="테마 전환" onclick="toggleOmniNodeTheme()">☀️</button>
</nav>

<nav id="tabs">
  <button type="button" class="tab active" data-tab="conn">연결</button>
  <button type="button" class="tab" data-tab="search">검색</button>
  <button type="button" class="tab" data-tab="inject">주입</button>
  <button type="button" class="tab" data-tab="memory">기억</button>
  <button type="button" class="tab" data-tab="prompts">프롬프트</button>
  <button type="button" class="tab" data-tab="adv">고급</button>
</nav>

<div data-g="conn" style="display:block">
<label>인증 토큰</label>
<div class="hint">서버를 처음 실행할 때 자동 생성됩니다. 플러그인 연결 설정에 같은 값을 넣으세요. (서버 데이터 폴더의 auth-token 파일)</div>
<div class="row" style="align-items:stretch">
  <input type="password" id="token" placeholder="토큰 입력" style="flex:1">
  <button type="button" id="tok_show" class="secondary inline" style="margin-top:4px;padding:0 12px" title="잠시 보기">👁</button>
  <button type="button" id="tok_copy" class="secondary inline" style="margin-top:4px;padding:0 12px" title="복사">복사</button>
</div>
<div class="download-hint">RisuAI 플러그인(OmniNode Connector)은 별도 배포됩니다 — 플러그인 리포의 설치 URL을 RisuAI 플러그인 메뉴에 추가하세요.</div>
</div>

<details class="sec panel" data-g="conn" open>
<summary>메인 LLM <span class="hint">기억을 만들고 고치는 모델 — 가장 성능이 필요한 자리</span></summary>
<label>API 형식</label>
<select id="c_format">
  <option value="auto">자동 (주소로 판별)</option>
  <option value="openai">OpenAI 호환 (chat/completions)</option>
  <option value="openai-responses">OpenAI Responses API</option>
  <option value="anthropic">Claude (Anthropic)</option>
  <option value="bedrock">Claude (AWS Bedrock)</option>
  <option value="gemini">Google AI Studio (Gemini API 키)</option>
  <option value="vertex">Google Vertex AI (서비스 계정)</option>
</select>
<div class="hint">잘 모르면 자동. 주소만으로 구분이 안 되는 Claude·Responses·Bedrock은 직접 고르세요. 형식마다 주소·키·모델을 따로 기억합니다. 바꿔도 이전 형식의 값은 지워지지 않습니다</div>
<div id="c_url_fields">
  <label>API URL</label><input type="text" id="c_url" placeholder="https://.../v1/chat/completions 또는 Gemini/Vertex 주소">
  <div class="hint" id="c_url_hint"></div>
</div>
<div id="c_vertex_fields" style="display:none">
  <label>GCP 리전</label><input type="text" id="c_gcp_region" placeholder="global">
  <div class="hint" id="c_vertex_url"></div>
</div>
<div id="c_bedrock_fields" style="display:none">
  <label>AWS 리전</label><input type="text" id="c_region" placeholder="us-east-1">
  <label>Bedrock 엔드포인트</label>
  <select id="c_bedrock">
    <option value="messages">신형 — Opus 4.7 이후 모델 (anthropic.claude-…)</option>
    <option value="invoke">구형 — Opus 4.6 이하 모델 (us.anthropic.… -v1:0, 무료 크레딧 대상)</option>
  </select>
  <div class="hint" id="c_bedrock_url"></div>
  <label>액세스 키 ID (AKIA…)</label><input type="text" id="c_aws_id">
  <label>시크릿 액세스 키</label><input type="password" id="c_aws_secret">
  <label>세션 토큰 (임시 자격증명일 때만)</label><input type="password" id="c_aws_token">
</div>
<div id="vx_sa_fields" style="display:none">
  <label>Vertex 서비스 계정 JSON — 메인·보조 공용</label>
  <textarea id="vx_sa" spellcheck="false" style="min-height:120px"></textarea>
  <div class="hint">Google Cloud 서비스 계정 키 JSON 전체를 붙여넣으세요. Vertex 주소일 때만 사용됩니다</div>
</div>
<label id="c_key_label">API 키 — 여러 개를 \\n으로 이으면 돌아가며 사용</label><input type="password" id="c_key">
<div class="hint" id="c_bedrock_key_hint" style="display:none">둘 중 하나만: Risu에서 쓰던 액세스 키(AKIA…)+시크릿을 그대로 넣거나, AWS 콘솔 → Bedrock → API keys에서 만든 API 키를 넣으세요</div>
<div class="row">
  <div><label>모델</label><input type="text" id="c_model"></div>
  <div><label>컨텍스트 윈도우</label><input type="number" id="c_ctx" placeholder="128000"></div>
</div>
<div class="row">
  <div><label>최대 응답 토큰</label><input type="number" id="c_max" placeholder="16000"></div>
  <div><label>온도</label><input type="number" id="c_temp" placeholder="0.3" min="0" max="2" step="0.05"></div>
</div>
<label>추가 요청 파라미터 (JSON)</label>
<textarea id="c_extra" style="min-height:64px" placeholder='예: {"reasoning": {"effort": "none"}}'></textarea>
<div class="hint">API 요청에 그대로 합쳐집니다. 추론 강도 조절 등 (예시 참고)</div>
<label>추가 헤더 (JSON)</label>
<textarea id="c_headers" style="min-height:44px" placeholder='예: {"X-Custom": "value"}'></textarea>
<button type="button" id="c_test" class="secondary inline">연결 테스트</button>
<div class="hint" id="c_test_result"></div>
</details>

<details class="sec panel" data-g="conn">
<summary>보조 LLM <span class="hint">요약·키워드 같은 가벼운 작업용 — 비우면 메인 LLM이 대신합니다. 싼 모델을 지정하면 비용이 크게 줄어요</span></summary>
<label>API 형식</label>
<select id="a_format">
  <option value="auto">자동 (주소로 판별)</option>
  <option value="openai">OpenAI 호환 (chat/completions)</option>
  <option value="openai-responses">OpenAI Responses API</option>
  <option value="anthropic">Claude (Anthropic)</option>
  <option value="bedrock">Claude (AWS Bedrock)</option>
  <option value="gemini">Google AI Studio (Gemini API 키)</option>
  <option value="vertex">Google Vertex AI (서비스 계정)</option>
</select>
<div class="hint">잘 모르면 자동. 주소만으로 구분이 안 되는 Claude·Responses·Bedrock은 직접 고르세요. 형식마다 주소·키·모델을 따로 기억합니다. 바꿔도 이전 형식의 값은 지워지지 않습니다</div>
<div id="a_url_fields">
  <label>API URL</label><input type="text" id="a_url">
  <div class="hint" id="a_url_hint"></div>
</div>
<div id="a_vertex_fields" style="display:none">
  <label>GCP 리전</label><input type="text" id="a_gcp_region" placeholder="global">
  <div class="hint" id="a_vertex_url"></div>
</div>
<div id="a_bedrock_fields" style="display:none">
  <label>AWS 리전</label><input type="text" id="a_region" placeholder="us-east-1">
  <label>Bedrock 엔드포인트</label>
  <select id="a_bedrock">
    <option value="messages">신형 — Opus 4.7 이후 모델 (anthropic.claude-…)</option>
    <option value="invoke">구형 — Opus 4.6 이하 모델 (us.anthropic.… -v1:0, 무료 크레딧 대상)</option>
  </select>
  <div class="hint" id="a_bedrock_url"></div>
  <label>액세스 키 ID (AKIA…)</label><input type="text" id="a_aws_id">
  <label>시크릿 액세스 키</label><input type="password" id="a_aws_secret">
  <label>세션 토큰 (임시 자격증명일 때만)</label><input type="password" id="a_aws_token">
</div>
<label id="a_key_label">API 키</label><input type="password" id="a_key">
<div class="hint" id="a_bedrock_key_hint" style="display:none">둘 중 하나만: Risu에서 쓰던 액세스 키(AKIA…)+시크릿을 그대로 넣거나, AWS 콘솔 → Bedrock → API keys에서 만든 API 키를 넣으세요</div>
<div class="row">
  <div><label>모델</label><input type="text" id="a_model"></div>
  <div><label>컨텍스트 윈도우</label><input type="number" id="a_ctx" placeholder="128000"></div>
</div>
<div class="row">
  <div><label>최대 응답 토큰</label><input type="number" id="a_max" placeholder="8000"></div>
  <div><label>온도</label><input type="number" id="a_temp" placeholder="0.2" min="0" max="2" step="0.05"></div>
</div>
<label>추가 요청 파라미터 (JSON)</label>
<textarea id="a_extra" style="min-height:64px" placeholder='예: {"reasoning": {"effort": "none"}}'></textarea>
<div class="hint">API 요청에 그대로 합쳐집니다. 추론 강도 조절 등 (예시 참고)</div>
<label>추가 헤더 (JSON)</label>
<textarea id="a_headers" style="min-height:44px"></textarea>
<button type="button" id="a_test" class="secondary inline">연결 테스트</button>
<div class="hint" id="a_test_result"></div>
</details>

<details class="sec panel" data-g="conn">
<summary>LLM 공통</summary>
<label>응답 타임아웃 (ms) — 0 = 무제한, 비우면 기본 180000 (3분)</label>
<input type="number" id="t_llm" placeholder="180000" min="0" step="1000">
<div class="row">
  <div><label>분당 요청 제한 (RPM) — 0 = 제한 없음</label><input type="number" id="rpm" placeholder="0" min="0"><div class="hint">API 요금제의 분당 한도에 맞추세요. 한도 초과 오류가 자주 나면 여기를 낮추는 게 첫 번째 처방</div></div>
  <div><label>실패 재시도 횟수</label><input type="number" id="retries" placeholder="3" min="0"></div>
</div>
</details>

<details class="sec panel" data-g="search" open>
<summary>임베딩</summary>
<div class="chk"><input type="checkbox" id="e_on"><label for="e_on">임베딩 사용 — 의미 기반 검색</label></div>
<div class="hint">대화와 기억을 '의미'로 비교해 찾습니다. 끄면 키워드 검색만 남아, 이름이 정확히 언급되지 않은 기억은 찾기 어렵습니다. 엔드포인트·키를 넣고 꼭 켜는 것을 권장 (기본은 꺼짐 — 켜기 전 설정 필요)</div>
<label>엔드포인트</label><input type="text" id="e_url" placeholder="https://api.voyageai.com/v1/embeddings 등">
<label>API 키</label><input type="password" id="e_key">
<label>모델</label><input type="text" id="e_model" placeholder="voyage-4 / text-embedding-3-small 등">
<div class="chk"><input type="checkbox" id="e_excl"><label for="e_excl">유저 메시지는 임베딩에서 제외</label></div>
<div class="hint">검색 기준을 봇의 서술에만 맞춥니다. 유저 발화가 짧거나 명령조일 때 검색 잡음이 줄어요</div>
<button type="button" id="e_test" class="secondary inline">임베딩 테스트</button>
<div class="hint" id="e_test_result"></div>
</details>

<details class="sec panel" data-g="search">
<summary>리랭커 <span class="hint">찾아낸 기억들의 순서를 한 번 더 다듬는 선택 기능 — 비우면 사용 안 함</span></summary>
<label>엔드포인트</label><input type="text" id="r_url" placeholder="https://api.voyageai.com/v1/rerank (비우면 미사용)">
<label>API 키</label><input type="password" id="r_key">
<label>모델</label><input type="text" id="r_model" placeholder="rerank-2.5-lite 등">
<button type="button" id="r_test" class="secondary inline">리랭커 테스트</button>
<div class="hint" id="r_test_result"></div>
</details>

<details class="sec panel" data-g="search">
<summary>검색·키워드</summary>
<div class="chk"><input type="checkbox" id="hyde_on"><label for="hyde_on">가상 답변 검색 (HyDE)</label></div>
<div class="hint">다음에 나올 법한 장면을 미리 상상해 그걸로 기억을 검색합니다. 직접 언급되지 않은 연관 기억을 잘 찾아냅니다</div>
<div class="row">
  <div><label>검색 융합 상수 (RRF k)</label><input type="number" id="rrfk" placeholder="60" min="1"><div class="hint">키워드·의미 검색 결과를 합칠 때 쓰는 상수. 잘 모르면 그대로 두세요</div></div>
  <div><label>키워드 추출 대상 최근 메시지 수</label><input type="number" id="kw_recent" placeholder="3" min="1"></div>
</div>
<div class="chk"><input type="checkbox" id="gl_on"><label for="gl_on">경량 키워드 추출 (GLiNER)</label></div>
<div class="hint">가벼운 개체명 인식 서버가 있으면 키워드 추출을 LLM 없이 빠르고 저렴하게 합니다. 비워두면 LLM이 추출 (기본)</div>
<label>GLiNER 엔드포인트</label><input type="text" id="gl_url">
<label>GLiNER API 키</label><input type="password" id="gl_key">
<label>GLiNER 라벨 (쉼표 구분)</label><input type="text" id="gl_labels" placeholder="person, place, time, organization, ...">
<div class="chk"><input type="checkbox" id="dkm_on"><label for="dkm_on">로어북 키 직격 매칭 <span class="badge" title="원작 플러그인에 없는 서버판 고유 기능">서버판</span> — LLM이 놓친 이름도 substring으로 검색</label></div>
<div class="hint">기억의 활성화 키가 최근 대화에 그대로 등장하면, 키워드 추출이 놓쳐도 반드시 검색 후보에 넣습니다</div>
<div class="chk"><input type="checkbox" id="keyword_rev_on"><label for="keyword_rev_on">잊힌 기억 깨우기</label></div>
<div class="hint">오래 안 나와 흐려진 기억도 이름이 다시 언급되면 즉시 깨어납니다</div>
</details>

<details class="sec panel" data-g="inject" open>
<summary>주입·예산</summary>
<label>최근 대화 보호 구간 (메시지 수)</label><input type="number" id="stw" placeholder="9" min="1">
<div class="hint">가장 최근 N개 메시지는 아직 진행 중인 장면으로 보고 그대로 남기며, 그 앞 9개는 요약으로 접혀 들어갑니다. Risu 프롬프트 템플릿에는 채팅을 <b>N + 9개</b>만큼 남기도록 설정하세요.</div>
<label>노드 내용 최대 길이 (자) — 0 = 무제한, 로어는 항상 전문</label>
<input type="number" id="t_nodechars" placeholder="12000" min="0" step="1000">
<label>기억 유용성 학습 (MemRL)</label>
<select id="memrl_mode"><option value="off">끄기</option><option value="embedding" selected>임베딩 (기본)</option><option value="llm">LLM</option></select>
<div class="hint">지난 턴에 넣어준 기억이 실제 응답에 쓰였는지 채점해, 쓸모 있던 기억을 다음부터 더 잘 올립니다. 임베딩 = 유사도로 추가 비용 없이 채점, LLM = 모델이 직접 채점 (턴당 호출 1회 추가), 끄기 = 학습 안 함</div>
<div class="chk"><input type="checkbox" id="dx_on"><label for="dx_on">중요 기억에 실제 대사 인용 <span class="badge" title="원작 플러그인에 없는 서버판 고유 기능">서버판</span></label></div>
<div class="hint">요약만으론 말투와 정확한 표현이 사라집니다. 중요한 기억엔 그때의 실제 대사 몇 줄을 인용으로 붙여 '정확히 뭐라고 했는지'를 기억하게 합니다</div>
<div class="row">
  <div><label>인용에 쓸 예산 비율 (0~1)</label><input type="number" id="dx_share" placeholder="0.25" min="0" max="1" step="0.05"></div>
  <div><label>인용을 붙일 최소 중요도 (1~5)</label><input type="number" id="dx_imp" placeholder="4" min="1" max="5"></div>
  <div><label>메시지당 발췌 자수</label><input type="number" id="dx_chars" placeholder="400" min="50" step="50"></div>
</div>
<label>기억 연결 반감기 (턴)</label>
<input type="number" id="ehl" placeholder="100" min="1">
<div class="hint">기억 사이의 연결은 시간이 지나면 약해집니다. 이 턴 수가 지나면 연결 강도가 절반이 됩니다</div>
</details>

<details class="sec panel" data-g="inject">
<summary>커뮤니티·챕터</summary>
<label>커뮤니티 최대 크기 <span class="badge" title="원작 플러그인에 없는 서버판 고유 기능">서버판</span> — 0 = 제한 없음</label>
<input type="number" id="mcs" placeholder="25" min="0">
<div class="hint">관련 기억을 묶는 '커뮤니티' 하나의 최대 크기. 제한을 없애면 긴 연속 서사가 거대한 한 덩어리로 묶일 수 있습니다</div>
<label>커뮤니티 요약 시 기억당 읽는 글자 수 — 0 = 전문</label>
<input type="number" id="csmc" placeholder="0" min="0" step="100">
</details>

<details class="sec panel" data-g="memory" open>
<summary>기억 형성 <span class="hint">기억을 만드는 과정의 세부 조절</span></summary>
<label>한 번에 만들 최대 기억 수 — 0 = 제한 없음</label>
<input type="number" id="ltm_cap" placeholder="32" min="0">
<div class="hint">제한을 없애면 기억이 잘게 쪼개져 수가 폭증할 수 있습니다</div>
<div class="chk"><input type="checkbox" id="tp_on"><label for="tp_on">기억 연결을 별도 단계에서 처리 <span class="badge" title="원작 플러그인에 없는 서버판 고유 기능">서버판</span></label></div>
<div class="hint">기억을 만든 뒤 연결(관계)만 한 번 더 물어봅니다. 캐시 덕에 두 번째 호출은 훨씬 싸고, 응답이 잘릴 때 연결부터 사라지는 문제가 없어집니다. 끄면 한 번에 처리</div>
<div class="chk"><input type="checkbox" id="oa_on"><label for="oa_on">봇 메시지만 기억으로 만들기</label></div>
<div class="hint">유저 발화는 참고만 하고, 기억 자체는 봇의 서술에서만 만듭니다</div>
<div class="chk"><input type="checkbox" id="mg_on"><label for="mg_on">비슷한 엔티티 자동 합치기</label></div>
<div class="hint">같은 인물·사물이 이름만 조금 다르게 중복 생성되면 하나로 흡수합니다</div>
<div class="row">
  <div><label>이름 유사도 기준 (0~1)</label><input type="number" id="mg_name" placeholder="0.7" min="0" max="1" step="0.05"></div>
  <div><label>의미 유사도 기준 (0~1)</label><input type="number" id="mg_vec" placeholder="0.85" min="0" max="1" step="0.05"></div>
</div>
<label>엔티티 이름 언어 (비우면 자동)</label><input type="text" id="lang" placeholder="예: Korean">
<div class="hint">기억 속 인물·사물 이름을 적을 언어. 채팅 언어와 다르게 강제하고 싶을 때만</div>
</details>

<details class="sec panel" data-g="memory">
<summary>백그라운드 <span class="hint">채팅이 쉴 때 뒤에서 돌아가는 기억 정리</span></summary>
<div class="chk"><input type="checkbox" id="ad_on"><label for="ad_on">유휴 시 기억 정리 (오토드림)</label></div>
<div class="hint">입력이 잠시 멈추면 백그라운드에서 기억을 정리합니다 — 관련 기억 묶기, 끊긴 연결 잇기, 세계 진행, 기억 압축</div>
<div class="row">
  <div><label>유휴 대기 (초)</label><input type="number" id="ad_int" placeholder="60" min="15" max="300"></div>
  <div><label>실행 최소 새 메시지</label><input type="number" id="ad_min" placeholder="4" min="0"></div>
</div>
<div class="chk"><input type="checkbox" id="ws_on"><label for="ws_on">화면 밖 세계 진행 (월드심)</label></div>
<div class="hint">보이지 않는 곳에서도 세계가 흘러갑니다. 생성된 사건은 장기 기억으로 저장돼 대화에 자연스럽게 스며듭니다</div>
<div class="row">
  <div><label>실행 주기 (기억 정리 N회당 1회)</label><input type="number" id="ws_int" placeholder="3" min="1" max="10"></div>
  <div><label>회당 최대 사건 수</label><input type="number" id="ws_max" placeholder="5" min="1" max="10"></div>
</div>
<div class="chk"><input type="checkbox" id="rc_on"><label for="rc_on">누적된 기억 정정을 하나로 정리 <span class="badge" title="원작 플러그인에 없는 서버판 고유 기능">서버판</span></label></div>
<div class="hint">기억에는 나중에 알게 된 정정 메모가 계속 붙습니다. 일정 수 이상 쌓이면 원문과 메모를 합쳐 '처음부터 그렇게 알고 있었던 것처럼' 매끄러운 하나로 다시 씁니다. 봇 제작자가 쓴 로어 원문은 절대 건드리지 않고 메모끼리만 합칩니다</div>
<div class="row">
  <div><label>정리를 시작할 메모 수</label><input type="number" id="rc_min" placeholder="3" min="2"></div>
  <div><label>한 번에 정리할 최대 기억 수</label><input type="number" id="rc_max" placeholder="2" min="1"></div>
</div>
<label>정리 결과 최대 길이 비율 (0~1) — 0 = 무제한</label>
<input type="number" id="rc_ratio" min="0" max="1" step="0.01">
<div class="hint">합친 결과가 원래 메모 합계의 이 비율보다 길면 반영하지 않습니다 (내용이 늘어나는 것 방지)</div>
<div class="chk"><input type="checkbox" id="md_atlas"><label for="md_atlas">세계 요약 자동 갱신 (ATLAS)</label></div>
<div class="hint">20턴마다 세계 전체 상태를 짧게 요약해 두고, 검색 키워드 추출과 백그라운드 정리(월드심 등)의 참고 자료로 씁니다. 끄면 요약 없이 진행합니다</div>
</details>

<details class="sec panel" data-g="memory">
<summary>챗 복사 승계 <span class="badge" title="원작 플러그인에 없는 서버판 고유 기능">서버판</span></summary>
<div class="chk"><input type="checkbox" id="cd_on"><label for="cd_on">복사된 채팅 자동 감지 — 기존 채팅의 기억을 자동으로 이어받기</label></div>
<div class="hint">채팅을 복사(분기)하면 원본이 쌓은 기억도 따라갑니다</div>
<label>복사로 판정할 최소 일치 메시지 수</label>
<input type="number" id="cd_min" placeholder="8" min="4">
<div class="hint">너무 낮으면 첫 메시지만 같은 다른 채팅을 복사로 오인할 수 있습니다</div>
</details>

<details class="sec panel" data-g="memory">
<summary>기억에서 제외할 패턴 (정규식) <span class="hint">기억을 만들기 전에 지우거나 바꿀 텍스트 — 이미지 생성 명령어 등</span></summary>
<div id="rx_list"></div>
<button type="button" id="rx_add" class="secondary">+ 필터 추가</button>
</details>

<div data-g="prompts" class="prompt-hint">프롬프트는 기본값이 미리 채워져 있습니다. 수정하면 커스텀으로 저장되고, 롤백 버튼으로 언제든 기본값으로 돌아갑니다.</div>
${PROMPT_CARDS_HTML}

<details class="sec panel" data-g="adv" open>
<summary>타입 다양성 감쇠 <span class="hint">한 종류의 기억만 우르르 주입되지 않게, 같은 종류가 연속될수록 점수를 깎습니다 (0~1, 낮을수록 강하게)</span></summary>
<div class="grid4">
  <div><label>로어</label><input type="number" id="tdd_lore" placeholder="0.75" min="0" max="1" step="0.01"></div>
  <div><label>엔티티</label><input type="number" id="tdd_extra" placeholder="0.78" min="0" max="1" step="0.01"></div>
  <div><label>장기 기억</label><input type="number" id="tdd_ltm" placeholder="0.92" min="0" max="1" step="0.01"></div>
  <div><label>커뮤니티</label><input type="number" id="tdd_comm" placeholder="0.90" min="0" max="1" step="0.01"></div>
</div>
<div class="chk"><input type="checkbox" id="inj_debug_on"><label for="inj_debug_on">낙선 후보 기록 (디버그)</label></div>
<div class="hint">주입 뷰어에 '아깝게 떨어진 기억' 목록과 탈락 사유를 남깁니다. 회상이 이상할 때 켜보세요</div>
</details>

<details class="sec panel" data-g="adv">
<summary>관계 타입 가중치 <span class="hint">기억 그물을 타고 번지는 검색에서 연결 종류별 중요도</span></summary>
<div class="grid4">
  <div><label>원인(causes)</label><input type="number" id="rw_causes" placeholder="0.7" min="0" max="1" step="0.05"></div>
  <div><label>가능(enables)</label><input type="number" id="rw_enables" placeholder="0.6" min="0" max="1" step="0.05"></div>
  <div><label>방지(prevents)</label><input type="number" id="rw_prevents" placeholder="0.5" min="0" max="1" step="0.05"></div>
  <div><label>모순(contradicts)</label><input type="number" id="rw_contra" placeholder="0.5" min="0" max="1" step="0.05"></div>
  <div><label>발전(develops)</label><input type="number" id="rw_develops" placeholder="0.6" min="0" max="1" step="0.05"></div>
  <div><label>연관(related)</label><input type="number" id="rw_related" placeholder="0.3" min="0" max="1" step="0.05"></div>
  <div><label>소속(parent)</label><input type="number" id="rw_parent" placeholder="0.8" min="0" max="1" step="0.05"></div>
  <div><label>기타(default)</label><input type="number" id="rw_default" placeholder="0.5" min="0" max="1" step="0.05"></div>
</div>
</details>

<details class="sec panel" data-g="adv" open>
<summary>설정 백업·복원 (JSON) <span class="hint">현재 설정 전체를 복사해두거나, 복사해둔 설정을 붙여넣어 복원합니다</span></summary>
<textarea id="raw" spellcheck="false"></textarea>
</details>

<div id="actionbar"><div class="inner">
  <div class="row">
    <button id="save" class="primary" style="flex:1">저장</button>
    <button id="reload" class="secondary" style="flex:0 0 auto">다시 불러오기</button>
  </div>
  <div id="status"></div>
</div></div>

<script>
const $ = id => document.getElementById(id);
const status = (msg, cls) => { $('status').textContent = msg; $('status').className = cls || ''; };
const headers = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + $('token').value.trim() });
const PROMPT_DEFAULTS = ${PROMPT_DEFAULTS_JSON};

// ── 탭 전환 (표시만 — DOM 유지로 저장 한 번 의미론 보존) ──
function switchTab(g) {
  // 기본 CSS가 [data-g]를 전부 숨기므로, 매칭 요소는 명시적 block이어야 함 ('' 는 도로 숨김)
  document.querySelectorAll('[data-g]').forEach(el => { el.style.display = el.dataset.g === g ? 'block' : 'none'; });
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === g));
  localStorage.setItem('omninode_tab', g);
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// 토큰: #token=... 프래그먼트 → localStorage
const hashToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (hashToken) { localStorage.setItem('omninode_token', hashToken); history.replaceState(null, '', location.pathname); }
$('token').value = localStorage.getItem('omninode_token') || '';
switchTab(localStorage.getItem('omninode_tab') || 'conn');

// 토큰 잠시 보기(15초 후 자동 마스킹) + 복사 — 키 분실 시 서버 재시작 없이 회수 가능하게
let tokHideTimer = null;
const maskToken = () => { $('token').type = 'password'; $('tok_show').textContent = '👁'; clearTimeout(tokHideTimer); tokHideTimer = null; };
$('tok_show').onclick = () => {
  if ($('token').type === 'password') {
    $('token').type = 'text'; $('tok_show').textContent = '🙈';
    tokHideTimer = setTimeout(maskToken, 15000);
  } else maskToken();
};
$('tok_copy').onclick = () => {
  const v = $('token').value.trim();
  if (!v) { status('복사할 토큰이 없습니다.', 'err'); return; }
  const done = () => status('토큰을 클립보드에 복사했습니다.', 'ok');
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(v).then(done); return; }
  // LAN HTTP에는 clipboard API가 없음 — 임시로 text 전환 후 execCommand 폴백
  const wasMasked = $('token').type === 'password';
  if (wasMasked) $('token').type = 'text';
  $('token').select();
  try { document.execCommand('copy'); done(); } catch { status('복사 실패 — 눈 버튼으로 표시 후 직접 복사하세요.', 'err'); }
  $('token').setSelectionRange(0, 0); $('token').blur();
  if (wasMasked) $('token').type = 'password';
};

let raw = {};
const path = (obj, keys) => keys.reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
const setPath = (obj, keys, v) => {
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) { if (typeof o[keys[i]] !== 'object' || o[keys[i]] === null) o[keys[i]] = {}; o = o[keys[i]]; }
  o[keys.at(-1)] = v;
};

// 타입: s=문자열 n=숫자 b=체크박스 j=JSON객체 csv=쉼표배열 p=프롬프트(비우면 null=기본값)
const FIELDS = [
  ['c_format', ['customLlm','apiFormat'], 's'], ['c_url', ['customLlm','apiUrl'], 's'],
  ['c_region', ['customLlm','awsRegion'], 's'], ['c_bedrock', ['customLlm','bedrockEndpoint'], 's'],
  ['c_gcp_region', ['customLlm','gcpRegion'], 's'],
  ['c_aws_id', ['customLlm','awsAccessKeyId'], 's'], ['c_aws_secret', ['customLlm','awsSecretAccessKey'], 's'],
  ['c_aws_token', ['customLlm','awsSessionToken'], 's'],
  ['vx_sa', ['vertexAiServiceAccountJson'], 's'], ['c_key', ['customLlm','apiKey'], 's'],
  ['c_model', ['customLlm','model'], 's'], ['c_ctx', ['customLlm','contextWindow'], 'n'],
  ['c_max', ['customLlm','maxTokens'], 'n'], ['c_temp', ['customLlm','temperature'], 'n'],
  ['c_extra', ['customLlm','extraBody'], 'j'], ['c_headers', ['customLlm','extraHeaders'], 'j'],
  ['a_format', ['auxiliaryLlm','apiFormat'], 's'], ['a_url', ['auxiliaryLlm','apiUrl'], 's'],
  ['a_region', ['auxiliaryLlm','awsRegion'], 's'], ['a_bedrock', ['auxiliaryLlm','bedrockEndpoint'], 's'],
  ['a_gcp_region', ['auxiliaryLlm','gcpRegion'], 's'],
  ['a_aws_id', ['auxiliaryLlm','awsAccessKeyId'], 's'], ['a_aws_secret', ['auxiliaryLlm','awsSecretAccessKey'], 's'],
  ['a_aws_token', ['auxiliaryLlm','awsSessionToken'], 's'],
  ['a_key', ['auxiliaryLlm','apiKey'], 's'],
  ['a_model', ['auxiliaryLlm','model'], 's'], ['a_ctx', ['auxiliaryLlm','contextWindow'], 'n'],
  ['a_max', ['auxiliaryLlm','maxTokens'], 'n'], ['a_temp', ['auxiliaryLlm','temperature'], 'n'],
  ['a_extra', ['auxiliaryLlm','extraBody'], 'j'], ['a_headers', ['auxiliaryLlm','extraHeaders'], 'j'],
  ['t_llm', ['llmTimeoutMs'], 'n'], ['rpm', ['rpm'], 'n'], ['retries', ['maxRetries'], 'n'],
  ['e_on', ['embeddingEnabled'], 'b'], ['e_url', ['embeddingEndpoint'], 's'], ['e_key', ['embeddingApiKey'], 's'], ['e_model', ['embeddingModel'], 's'],
  ['e_excl', ['excludeUserEmbedding'], 'b'],
  ['r_url', ['rerankerEndpoint'], 's'], ['r_key', ['rerankerApiKey'], 's'], ['r_model', ['rerankerModel'], 's'],
  ['hyde_on', ['hydeEnabled'], 'b'], ['rrfk', ['rrfK'], 'n'], ['kw_recent', ['keywordRecentMessages'], 'n'],
  ['gl_on', ['useGliner'], 'b'], ['gl_url', ['glinerEndpoint'], 's'], ['gl_key', ['glinerApiKey'], 's'], ['gl_labels', ['glinerLabels'], 'csv'],
  ['dkm_on', ['directKeyMatchEnabled'], 'b'], ['keyword_rev_on', ['keywordRevivalEnabled'], 'b'],
  ['stw', ['shortTermWindow'], 'n'],
  ['t_nodechars', ['maxNodeContentChars'], 'n'], ['memrl_mode', ['memrlMode'], 's'],
  ['dx_on', ['dynamicExcerptEnabled'], 'b'], ['dx_share', ['dynamicExcerptBudgetShare'], 'n'],
  ['dx_imp', ['dynamicExcerptImportanceBase'], 'n'], ['dx_chars', ['dynamicExcerptMaxCharsPerMsg'], 'n'],
  ['ehl', ['edgeHalfLife'], 'n'],
  ['ltm_cap', ['ltmMaxNodesPerBatch'], 'n'], ['tp_on', ['agentTwoPassRelationships'], 'b'],
  ['oa_on', ['useOnlyAssistantRole'], 'b'],
  ['mg_on', ['mergeEnabled'], 'b'], ['mg_name', ['mergeNameThreshold'], 'n'], ['mg_vec', ['mergeVectorThreshold'], 'n'],
  ['lang', ['entityNameLanguage'], 's'],
  ['mcs', ['maxCommunitySize'], 'n'], ['csmc', ['communitySummaryMemberChars'], 'n'],
  ['ad_on', ['autodreamEnabled'], 'b'], ['ad_int', ['autodreamAutoInterval'], 'n'], ['ad_min', ['autodreamAutoMinMessages'], 'n'],
  ['ws_on', ['worldSimEnabled'], 'b'], ['ws_int', ['worldSimInterval'], 'n'], ['ws_max', ['worldSimMaxNodes'], 'n'],
  ['rc_on', ['reevalCompactionEnabled'], 'b'], ['rc_min', ['reevalCompactionMinNotes'], 'n'], ['rc_max', ['reevalCompactionMaxPerRun'], 'n'],
  ['rc_ratio', ['loreNoteCompactionMaxRatio'], 'n'],
  ['md_atlas', ['mdAtlasEnabled'], 'b'],
  ['cd_on', ['copyDetectEnabled'], 'b'], ['cd_min', ['copyDetectMinPrefix'], 'n'],
  ['tdd_lore', ['typeDiversityDecay','lore'], 'n'], ['tdd_extra', ['typeDiversityDecay','extraLore'], 'n'],
  ['tdd_ltm', ['typeDiversityDecay','longTermMemory'], 'n'], ['tdd_comm', ['typeDiversityDecay','communitySummary'], 'n'],
  ['inj_debug_on', ['injectionDebugEnabled'], 'b'],
  ['rw_causes', ['relationshipWeights','causes'], 'n'], ['rw_enables', ['relationshipWeights','enables'], 'n'],
  ['rw_prevents', ['relationshipWeights','prevents'], 'n'], ['rw_contra', ['relationshipWeights','contradicts'], 'n'],
  ['rw_develops', ['relationshipWeights','develops'], 'n'], ['rw_related', ['relationshipWeights','related'], 'n'],
  ['rw_parent', ['relationshipWeights','parent'], 'n'], ['rw_default', ['relationshipWeights','default'], 'n'],
  ['p_custom', ['customPrompt'], 'p'], ['p_comm', ['communitySummaryPrompt'], 'p'],
  ['p_super', ['superCommunityPrompt'], 'p'], ['p_ws', ['worldSimPrompt'], 'p'],
  ['p_compact', ['compactionPrompt'], 'p'], ['p_lore_compact', ['loreNoteCompactionPrompt'], 'p'],
  ['p_hyde', ['hydePrompt'], 'p'],
  ['p_memrl_s', ['memrlSystemPrompt'], 'p'], ['p_memrl_u', ['memrlUserPromptTemplate'], 'p'],
];

const FORMAT_PLACEHOLDERS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  'openai-responses': 'https://api.openai.com/v1/responses',
  anthropic: 'https://api.anthropic.com/v1/messages',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
  vertex: 'https://aiplatform.googleapis.com/v1/projects/{project}/locations/global',
};
const AUTO_URL_PLACEHOLDERS = {
  c: 'https://.../v1/chat/completions 또는 Gemini/Vertex 주소',
  a: '',
};
const DEFAULT_KEY_LABELS = {
  c: $('c_key_label').textContent,
  a: $('a_key_label').textContent,
};
const profiles = { c: {}, a: {} };
const currentFormat = { c: 'auto', a: 'auto' };

function profileFields(prefix) {
  const endpointKey = prefix === 'c' ? 'customLlm' : 'auxiliaryLlm';
  return FIELDS.filter(([id, keys]) => id.startsWith(prefix + '_') && keys[0] === endpointKey && keys[1] !== 'apiFormat');
}

function snapshotProfile(prefix) {
  const format = currentFormat[prefix] || 'auto';
  const profile = { ...(profiles[prefix][format] || {}) };
  for (const [id, keys, t] of profileFields(prefix)) {
    const key = keys[1];
    if (t === 'n') profile[key] = $(id).value ? Number($(id).value) : undefined;
    else if (t === 'j') {
      const txt = $(id).value.trim();
      if (!txt) profile[key] = {};
      else {
        try {
          const value = JSON.parse(txt);
          profile[key] = (value && typeof value === 'object' && !Array.isArray(value)) ? value : txt;
        } catch { profile[key] = txt; }
      }
    } else profile[key] = $(id).value;
  }
  profiles[prefix][format] = profile;
}

function restoreProfile(prefix, profile) {
  for (const [id, keys, t] of profileFields(prefix)) {
    const value = profile?.[keys[1]];
    if (id === prefix + '_bedrock') $(id).value = value || 'messages';
    else if (t === 'j') $(id).value = value && typeof value === 'object' && Object.keys(value).length > 0
      ? JSON.stringify(value, null, 2)
      : (typeof value === 'string' ? value : '');
    else $(id).value = value ?? '';
    touched.add(id);
  }
}

function validateProfiles() {
  for (const prefix of ['c', 'a']) {
    for (const [format, profile] of Object.entries(profiles[prefix])) {
      for (const [, keys, t] of profileFields(prefix)) {
        if (t === 'j' && typeof profile[keys[1]] === 'string') {
          status('JSON이 올바르지 않습니다: ' + prefix + '_' + (keys[1] === 'extraBody' ? 'extra' : 'headers') + ' (' + format + ')', 'err');
          return false;
        }
      }
    }
  }
  return true;
}

function syncFormatFields(prefix) {
  const formatSelect = $(prefix + '_format');
  if (!formatSelect.value) formatSelect.value = 'auto';
  const bedrockSelect = $(prefix + '_bedrock');
  if (!bedrockSelect.value) bedrockSelect.value = 'messages';
  const format = formatSelect.value;
  const isBedrock = format === 'bedrock';
  const isVertex = format === 'vertex';
  $(prefix + '_url_fields').style.display = isBedrock ? 'none' : 'block';
  $(prefix + '_bedrock_fields').style.display = isBedrock ? 'block' : 'none';
  $(prefix + '_vertex_fields').style.display = isVertex ? 'block' : 'none';
  $(prefix + '_url').placeholder = FORMAT_PLACEHOLDERS[format] ?? AUTO_URL_PLACEHOLDERS[prefix];
  $(prefix + '_url_hint').textContent = isVertex
    ? '비워두면 서비스 계정 JSON의 project_id와 리전으로 자동 조립합니다'
    : format !== 'auto' && !isBedrock
      ? '비워두면 이 형식의 기본 주소를 사용합니다'
      : '';
  $(prefix + '_key_label').textContent = isBedrock
    ? 'Bedrock API 키 — 액세스 키 ID·시크릿을 넣었으면 비워둡니다'
    : DEFAULT_KEY_LABELS[prefix];
  $(prefix + '_bedrock_key_hint').style.display = isBedrock ? 'block' : 'none';

  const region = $(prefix + '_region').value.trim() || '{region}';
  const model = $(prefix + '_model').value.trim() || '{modelId}';
  const endpoint = bedrockSelect.value;
  const assembledUrl = endpoint === 'invoke'
    ? 'https://bedrock-runtime.' + region + '.amazonaws.com/model/' + encodeURIComponent(model).replace(/%3A/gi, ':') + '/invoke'
    : 'https://bedrock-mantle.' + region + '.api.aws/anthropic/v1/messages';
  $(prefix + '_bedrock_url').textContent = '요청 주소: ' + assembledUrl;

  let projectId = '';
  try {
    const serviceAccount = JSON.parse($('vx_sa').value);
    if (typeof serviceAccount.project_id === 'string') projectId = serviceAccount.project_id.trim();
  } catch { /* 붙여넣는 중에는 안내 문구 유지 */ }
  if (projectId) {
    const gcpRegion = $(prefix + '_gcp_region').value.trim() || 'global';
    const vertexModel = $(prefix + '_model').value.trim();
    const modelPath = vertexModel ? encodeURIComponent(vertexModel) : '{model}';
    const vertexBaseUrl = gcpRegion === 'global'
      ? 'https://aiplatform.googleapis.com/v1/projects/' + projectId + '/locations/global'
      : 'https://' + gcpRegion + '-aiplatform.googleapis.com/v1/projects/' + projectId + '/locations/' + gcpRegion;
    $(prefix + '_vertex_url').textContent = '요청 주소: ' + vertexBaseUrl + '/publishers/google/models/' + modelPath + ':generateContent';
  } else {
    $(prefix + '_vertex_url').textContent = '서비스 계정 JSON을 먼저 붙여넣으세요';
  }

  $('vx_sa_fields').style.display =
    ($('c_format').value === 'vertex' || $('a_format').value === 'vertex') ? 'block' : 'none';
}

for (const prefix of ['c', 'a']) {
  $(prefix + '_format').addEventListener('change', () => {
    snapshotProfile(prefix);
    const newFormat = $(prefix + '_format').value || 'auto';
    restoreProfile(prefix, profiles[prefix][newFormat]);
    currentFormat[prefix] = newFormat;
    syncFormatFields(prefix);
  });
  $(prefix + '_region').addEventListener('input', () => syncFormatFields(prefix));
  $(prefix + '_gcp_region').addEventListener('input', () => syncFormatFields(prefix));
  $(prefix + '_bedrock').addEventListener('change', () => syncFormatFields(prefix));
  $(prefix + '_model').addEventListener('input', () => syncFormatFields(prefix));
}
$('vx_sa').addEventListener('input', () => {
  syncFormatFields('c');
  syncFormatFields('a');
});

// 사용자가 실제로 만진 폼 필드만 저장에 반영 (미접촉 빈 필드가 값을 지우는 사고 방지)
const touched = new Set();
for (const [id] of FIELDS) {
  $(id).addEventListener('input', () => touched.add(id));
  $(id).addEventListener('change', () => touched.add(id));
}

// ── 프롬프트 편집기: 기본값 뱃지 + 불러오기/복원 ──
function updatePromptBadge(id) {
  const b = $(id + '_badge');
  if (!b) return;
  const isCustom = $(id).value.trim() !== '' && $(id).value !== (PROMPT_DEFAULTS[id] || '');
  b.textContent = isCustom ? '커스텀' : '기본값';
  b.classList.toggle('custom', isCustom);
}
for (const [id] of FIELDS.filter(f => f[2] === 'p')) {
  $(id).addEventListener('input', () => updatePromptBadge(id));
}
document.querySelectorAll('[data-preset]').forEach(btn => btn.addEventListener('click', () => {
  const id = btn.dataset.preset;
  if (updatePromptBadge(id), $(id).value !== (PROMPT_DEFAULTS[id] || '') && !confirm('커스텀 내용을 기본값으로 되돌립니다. 계속할까요?')) return;
  $(id).value = PROMPT_DEFAULTS[id] || '';
  touched.add(id); updatePromptBadge(id);
  status('기본값으로 되돌렸습니다. 저장을 누르면 확정됩니다.', 'ok');
}));

// ── 원문 변형 정규식 편집기 (원작 🔤 Chat Regex Filters 카드 이식) ──
let rxFilters = [];
let rxTouched = false;
function renderRx() {
  const list = $('rx_list');
  list.innerHTML = '';
  if (rxFilters.length === 0) {
    list.innerHTML = '<div class="empty-hint">필터 없음 — 이미지 명령어 등 기억에 넣지 않을 패턴을 추가하세요.</div>';
  }
  rxFilters.forEach((f, i) => {
    const d = document.createElement('div');
    d.className = 'rxrow';
    d.innerHTML = '<div class="row" style="align-items:stretch">' +
      '<input type="text" data-rf="label" placeholder="라벨 (선택)" style="flex:1">' +
      '<button type="button" class="secondary inline" data-rdel title="삭제" style="margin-top:4px;padding:0 12px">✕</button></div>' +
      '<div class="row">' +
      '<input type="text" data-rf="pattern" placeholder="정규식 패턴" style="flex:2">' +
      '<input type="text" data-rf="flags" placeholder="플래그" style="max-width:72px;flex:0 0 72px">' +
      '<input type="text" data-rf="replacement" placeholder="치환 (비우면 제거)" style="flex:1">' +
      '</div>';
    d.querySelectorAll('input[data-rf]').forEach(inp => {
      inp.value = f[inp.dataset.rf] ?? '';
      inp.addEventListener('input', () => { f[inp.dataset.rf] = inp.value; rxTouched = true; });
    });
    d.querySelector('[data-rdel]').addEventListener('click', () => { rxFilters.splice(i, 1); rxTouched = true; renderRx(); });
    list.appendChild(d);
  });
}
$('rx_add').onclick = () => { rxFilters.push({ label: '', pattern: '', flags: 'g', replacement: '' }); rxTouched = true; renderRx(); };

function fillForm(merged) {
  for (const [id, keys, t] of FIELDS) {
    const v = path(merged, keys);
    if (t === 'b') $(id).checked = !!v;
    else if (t === 'j') $(id).value = (v && Object.keys(v).length > 0) ? JSON.stringify(v, null, 2) : '';
    else if (t === 'csv') $(id).value = Array.isArray(v) ? v.join(', ') : '';
    else if (t === 'p') { $(id).value = (v ?? '') || (PROMPT_DEFAULTS[id] || ''); updatePromptBadge(id); }
    else $(id).value = v ?? '';
  }
  for (const prefix of ['c', 'a']) {
    const endpointKey = prefix === 'c' ? 'customLlm' : 'auxiliaryLlm';
    const savedProfiles = path(merged, [endpointKey, 'formatProfiles']);
    profiles[prefix] = savedProfiles && typeof savedProfiles === 'object' && !Array.isArray(savedProfiles)
      ? { ...savedProfiles }
      : {};
    currentFormat[prefix] = $(prefix + '_format').value || 'auto';
  }
  syncFormatFields('c');
  syncFormatFields('a');
  rxFilters = Array.isArray(merged.chatRegexFilters)
    ? merged.chatRegexFilters.map(f => ({ label: f.label || '', pattern: f.pattern || '', flags: f.flags || 'g', replacement: f.replacement || '' }))
    : [];
  renderRx();
  rxTouched = false;
  touched.clear(); // 프로그램이 채운 값은 "만진 것"이 아님
}

// 고급 JSON에 붙여넣으면 폼에 즉시 반영 (붙여넣은 값이 눈에 보이게)
$('raw').addEventListener('input', () => {
  try { fillForm(JSON.parse($('raw').value || '{}')); } catch { /* 타이핑 중 불완전 JSON 무시 */ }
});

async function load() {
  if (!$('token').value.trim()) { status('먼저 인증 토큰을 입력하세요.', 'err'); return; }
  localStorage.setItem('omninode_token', $('token').value.trim());
  try {
    const h = await fetch('/api/health').then(r => r.json());
    $('ver').textContent = 'v' + h.version;
    const [merged, rawResp] = await Promise.all([
      fetch('/api/config', { headers: headers() }),
      fetch('/api/config/raw', { headers: headers() }),
    ]);
    if (merged.status === 401) { status('토큰이 올바르지 않습니다.', 'err'); return; }
    raw = await rawResp.json();
    fillForm(await merged.json());
    $('raw').value = JSON.stringify(raw, null, 2);
    status('불러왔습니다. 수정 후 저장을 누르세요.', 'ok');
  } catch (e) { status('불러오기 실패: ' + e.message, 'err'); }
}

function collectConfig() {
  let base;
  try { base = JSON.parse($('raw').value || '{}'); } catch { status('고급 JSON이 올바르지 않습니다.', 'err'); return null; }
  snapshotProfile('c');
  snapshotProfile('a');
  if (!validateProfiles()) return null;
  for (const [id, keys, t] of FIELDS) {
    if (!touched.has(id)) continue; // 만지지 않은 필드는 base(고급 JSON)를 존중
    let v;
    if (t === 'b') v = $(id).checked;
    else if (t === 'n') v = $(id).value ? Number($(id).value) : undefined;
    else if (t === 'csv') v = $(id).value.split(',').map(s => s.trim()).filter(Boolean);
    else if (t === 'p') { const txt = $(id).value; v = (!txt.trim() || txt === (PROMPT_DEFAULTS[id] || '')) ? null : txt; } // 기본값과 동일/빈 값 = null (서버가 키 삭제 → 기본값 사용)
    else if (t === 'j') {
      const txt = $(id).value.trim();
      if (!txt) { if (path(base, keys) !== undefined) setPath(base, keys, {}); continue; }
      try { v = JSON.parse(txt); } catch { status('JSON이 올바르지 않습니다: ' + id, 'err'); return null; }
      if (typeof v !== 'object' || Array.isArray(v)) { status('JSON 객체여야 합니다: ' + id, 'err'); return null; }
    }
    else v = $(id).value;
    if (v !== undefined) setPath(base, keys, v); // 만진 필드는 빈 값도 의도된 삭제로 반영
  }
  setPath(base, ['customLlm', 'formatProfiles'], profiles.c);
  setPath(base, ['auxiliaryLlm', 'formatProfiles'], profiles.a);
  if (rxTouched) {
    base.chatRegexFilters = rxFilters
      .filter(f => f.pattern.trim())
      .map(f => ({ pattern: f.pattern.trim(), flags: f.flags.trim() || 'g', replacement: f.replacement, label: f.label.trim() }));
  }
  return base;
}

function showTestFailure(result, error) {
  result.textContent = '❌ 실패 — ' + error;
  result.className = 'hint err';
}

function formatDisplayName(prefix, format) {
  const option = Array.from($(prefix + '_format').options).find(o => o.value === format);
  return option ? option.textContent : format;
}

async function testConnection(prefix, target) {
  const button = $(prefix + '_test');
  const result = $(prefix + '_test_result');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '테스트 중…';
  result.textContent = '';
  result.className = 'hint';

  try {
    const config = collectConfig();
    if (!config) { showTestFailure(result, '설정 값을 확인하세요'); return; }
    const resp = await fetch('/api/config/test', {
      method: 'POST', headers: headers(), body: JSON.stringify({ target, config }),
    });
    let data;
    try { data = await resp.json(); } catch { throw new Error('HTTP ' + resp.status); }
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
    if (!data.ok) { showTestFailure(result, data.error); return; }

    result.className = 'hint';
    if (target === 'main' || target === 'aux') {
      const fallback = data.usedFallback ? ' · 보조 미설정이라 메인으로 보냈습니다' : '';
      result.textContent = '✅ 응답 "' + String(data.reply).slice(0, 40) + '" — ' + data.ms + 'ms · ' +
        formatDisplayName(prefix, data.format) + ' · ' + data.model + fallback;
    } else if (target === 'embedding') {
      result.textContent = '✅ ' + data.dims + '차원 벡터 수신 — ' + data.ms + 'ms';
    } else {
      result.textContent = '✅ 점수 수신 ' + data.scores.map(score => Number(score).toFixed(2)).join(', ') + ' — ' + data.ms + 'ms';
    }
  } catch (e) {
    showTestFailure(result, e.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

for (const [prefix, target] of [['c', 'main'], ['a', 'aux'], ['e', 'embedding'], ['r', 'reranker']]) {
  $(prefix + '_test').addEventListener('click', () => testConnection(prefix, target));
}

async function save() {
  try {
    const base = collectConfig();
    if (!base) return;
    const resp = await fetch('/api/config', { method: 'PUT', headers: headers(), body: JSON.stringify(base) });
    if (!resp.ok) { status('저장 실패: HTTP ' + resp.status, 'err'); return; }
    raw = base;
    $('raw').value = JSON.stringify(raw, null, 2);
    fillForm(base); // 저장된 값을 폼에 다시 표시 (키는 password 필드라 가려짐)
    status('저장했습니다. 다음 채팅부터 적용됩니다. ✅', 'ok');
  } catch (e) { status('저장 실패: ' + e.message, 'err'); }
}

$('save').onclick = save;
$('reload').onclick = load;
if ($('token').value) load();
else status('인증 토큰이 없어 설정을 불러오지 못했습니다 — 연결 탭에 토큰을 입력하고 "다시 불러오기"를 누르세요. (주소가 다르면 토큰 저장도 따로입니다: localhost와 IP 주소는 별개)', 'err');
</script>
</body>
</html>`;
