// 주입 내역 뷰어 — "방금 턴에 뭐가 주입됐는지" 회상 검증용 (E2E 대조 도구).
// 페이지 자체는 무인증(데이터 없음), 실제 조회는 localStorage의 토큰으로
// GET /api/chats/:chatKey/last-injection 호출 (설정 페이지와 같은 오리진 = 토큰 공유).
import { THEME_CSS, THEME_SCRIPT } from './theme.js';

export const INJECTION_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>${THEME_SCRIPT}</script>
<title>OmniNode 주입 내역</title>
<style>
${THEME_CSS}
  h1 { margin: 8px 0 12px; }
  h2 { margin: 20px 0 8px; }
  .meta { margin: 8px 0 16px; }
  .kw { margin: 4px 4px 4px 0; }
  .node h3 { margin: 0 0 8px; }
  .type { margin-right: 8px; vertical-align: middle; }
  .content { margin: 0; color: var(--text-dim); white-space: pre-wrap; }
  .summary { padding: 8px 12px; border-left: 4px solid var(--accent); color: var(--text-dim); white-space: pre-wrap; }
  .rejected { margin-top: 20px; }
  .rejected-row { font-size: 0.8rem; }
  .rejected-name { margin-right: 8px; font-weight: 700; }
  .rejected-score, .rejected-meta { margin-top: 4px; color: var(--text-dim); }
  .rejected-score { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
  #status { min-height: 20px; margin: 12px 0; }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .keywords { margin-bottom: 16px; }
</style>
</head>
<body>
<h1>🧠 마지막 턴 주입 내역</h1>
<nav class="topnav" aria-label="주요 메뉴">
  <a href="/settings">⚙️ 설정</a>
  <a href="/dashboard">📊 대시보드</a>
  <a href="/graph">🕸️ 그래프</a>
  <span class="current" aria-current="page">💉 주입 뷰어</span>
  <button type="button" class="theme-toggle" aria-label="테마 전환" onclick="toggleOmniNodeTheme()">☀️</button>
</nav>
<div class="bar">
  <select id="chatKey"></select>
  <button id="refresh" class="primary">새로고침</button>
</div>
<div id="status"></div>
<div id="out"></div>

<script>
const $ = (id) => document.getElementById(id);
const token = localStorage.getItem('omninode_token') || '';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const headers = { Authorization: 'Bearer ' + token };
const status = (msg, cls) => { $('status').textContent = msg; $('status').className = cls || ''; };
const nodeTypeClass = (type) => ({
  lore: 'node-lore',
  extraLore: 'node-extra',
  longTermMemory: 'node-ltm',
  communitySummary: 'node-comm',
})[type] || '';

const urlKey = new URLSearchParams(location.search).get('chatKey') || '';

async function loadChats() {
  const resp = await fetch('/api/chats', { headers });
  if (!resp.ok) throw new Error('chats ' + resp.status);
  const chats = await resp.json();
  const sel = $('chatKey');
  sel.innerHTML = chats.map(c =>
    '<option value="' + esc(c.chatKey) + '">' + esc(c.chatKey) + ' (turn ' + c.currentTurn + ')</option>').join('');
  if (urlKey) {
    if (![...sel.options].some(o => o.value === urlKey)) {
      sel.innerHTML = '<option value="' + esc(urlKey) + '">' + esc(urlKey) + '</option>' + sel.innerHTML;
    }
    sel.value = urlKey;
  }
}

async function load() {
  const chatKey = $('chatKey').value;
  if (!chatKey) { status('채팅이 없습니다.', 'err'); return; }
  status('불러오는 중…');
  const resp = await fetch('/api/chats/' + encodeURIComponent(chatKey) + '/last-injection', { headers });
  if (resp.status === 404) {
    const data = await resp.json().catch(() => ({}));
    $('out').innerHTML = '';
    status(data.error === 'no active session for this chat'
      ? '이 채팅의 세션이 램에 없어요 — 서버 재시작 후 아직 파이프라인이 돌지 않았습니다.'
      : '아직 기록된 주입이 없어요.', 'err');
    return;
  }
  if (!resp.ok) { status('오류: ' + resp.status, 'err'); return; }
  const inj = await resp.json();
  status('');
  const kws = (inj.keywords || []).map(k => '<span class="kw chip accent-chip">' + esc(k) + '</span>').join('');
  const nodes = (inj.nodes || []).map(n =>
    '<div class="node list-row"><h3><span class="type node-chip ' + nodeTypeClass(n.type) + '">' + esc(n.type) + '</span>' + esc(n.name || '(이름 없음)') + '</h3>' +
    '<pre class="content">' + esc(n.content || '') + '</pre></div>').join('');
  $('out').innerHTML =
    '<div class="meta">turn ' + inj.turn + ' · ' + new Date(inj.at).toLocaleString() + ' · 노드 ' + (inj.nodes || []).length + '개</div>' +
    (kws ? '<div class="keywords">검색 키워드: ' + kws + '</div>' : '') +
    (inj.summary ? '<h2>삽입된 요약</h2><div class="summary">' + esc(inj.summary) + '</div>' : '') +
    '<h2>주입된 노드</h2>' + (nodes || '<p>이번 턴에 주입된 노드가 없습니다.</p>');

  if (Array.isArray(inj.rejected) && inj.rejected.length > 0) {
    const details = document.createElement('details');
    details.className = 'rejected collapsible';
    const heading = document.createElement('summary');
    heading.textContent = '🏅 낙선 후보 (디버그)';
    details.appendChild(heading);

    for (const candidate of inj.rejected) {
      const row = document.createElement('div');
      row.className = 'rejected-row list-row';

      const name = document.createElement('span');
      name.className = 'rejected-name';
      name.textContent = candidate.name || '(이름 없음)';
      row.appendChild(name);

      const type = document.createElement('span');
      type.className = 'type node-chip ' + nodeTypeClass(candidate.type);
      type.textContent = candidate.type || 'unknown';
      row.appendChild(type);

      const score = document.createElement('div');
      score.className = 'rejected-score';
      const baseScore = Number(candidate.baseScore);
      const effScore = Number(candidate.effScore);
      const decayMultiplier = Number(candidate.decayMultiplier);
      const scoreText = Number.isFinite(baseScore) ? baseScore.toFixed(6) : '—';
      const effText = Number.isFinite(effScore) ? effScore.toFixed(6) : '—';
      const decayText = Number.isFinite(decayMultiplier) ? decayMultiplier.toFixed(4) : '—';
      score.textContent = '점수: ' + scoreText + ' → ' + effText + ' (×' + decayText + ')';
      row.appendChild(score);

      const meta = document.createElement('div');
      meta.className = 'rejected-meta';
      meta.textContent = '활성도: ' + String(candidate.activation ?? '—') + ' · 사유: ' + String(candidate.reason || '—');
      row.appendChild(meta);

      details.appendChild(row);
    }
    $('out').appendChild(details);
  }
}

$('refresh').addEventListener('click', load);
$('chatKey').addEventListener('change', load);

if (!token) {
  status('토큰이 없어요 — 먼저 설정 페이지를 한 번 열어 토큰을 저장하세요.', 'err');
  $('out').innerHTML = '<p><a href="/settings">설정 페이지 열기 →</a></p>';
} else {
  loadChats().then(load).catch(e => status('오류: ' + e.message, 'err'));
}
</script>
</body>
</html>`;
