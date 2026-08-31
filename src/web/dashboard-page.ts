// 대시보드 — 채팅 목록·잡 이력·기억 리셋/소거 (Phase 8b, PHASE8-UI.md §3).
// 설정 페이지와 분리: 그래프 뷰어(8c, 무거움)와도 분리된 가벼운 관리 화면.
// 토큰은 설정 페이지와 localStorage 공유 (같은 오리진).
import { THEME_CSS, THEME_SCRIPT } from './theme.js';

export const DASHBOARD_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>${THEME_SCRIPT}</script>
<title>OmniNode 대시보드</title>
<style>
${THEME_CSS}
  h1 { margin: 8px 0 4px; }
  .card { margin-top: 12px; }
  .card h3 { margin: 0; word-break: break-all; }
  .card .meta { margin-top: 4px; color: var(--accent); font-variant-numeric: tabular-nums; }
  .btns { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .jobs { margin-top: 8px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.74rem; font-variant-numeric: tabular-nums; }
  #status { min-height: 20px; margin-top: 8px; font-size: 0.8rem; font-weight: 500; line-height: 1.45; }
  .pill { margin-left: 8px; }
  .empty { margin-top: 16px; }
</style>
</head>
<body>
<h1>OmniNode 대시보드 <span class="pill" id="ver"></span></h1>
<nav class="topnav" aria-label="주요 메뉴">
  <a href="/settings">⚙️ 설정</a>
  <span class="current" aria-current="page">📊 대시보드</span>
  <a href="/graph">🕸️ 그래프</a>
  <a href="/injection">💉 주입 뷰어</a>
  <button type="button" class="theme-toggle" aria-label="테마 전환" onclick="toggleOmniNodeTheme()">☀️</button>
</nav>
<div id="status"></div>
<div id="list"></div>

<script>
const $ = id => document.getElementById(id);
const status = (msg, cls) => { $('status').textContent = msg; $('status').className = cls || ''; };
const token = localStorage.getItem('omninode_token') || '';
const headers = { 'Authorization': 'Bearer ' + token };

function ago(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + '초 전';
  if (s < 3600) return Math.floor(s / 60) + '분 전';
  if (s < 86400) return Math.floor(s / 3600) + '시간 전';
  return Math.floor(s / 86400) + '일 전';
}

async function toggleJobs(chatKey, box, btn) {
  if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = '0'; btn.textContent = '잡 이력'; return; }
  btn.textContent = '닫기';
  box.dataset.open = '1';
  box.innerHTML = '<div class="list-row">불러오는 중…</div>';
  try {
    const rows = await fetch('/api/jobs?chatKey=' + encodeURIComponent(chatKey), { headers }).then(r => r.json());
    box.innerHTML = rows.length === 0 ? '<div class="list-row">잡 이력 없음</div>' : '';
    for (const r of rows.slice(0, 15)) {
      const d = document.createElement('div');
      d.className = 'list-row';
      d.textContent = '#' + r.id + ' ' + r.kind + ' — ' + r.status + (r.last_error ? ' (' + r.last_error.slice(0, 60) + ')' : '');
      if (r.status === 'error') d.classList.add('err');
      box.appendChild(d);
    }
  } catch (e) { box.innerHTML = '<div class="list-row err">불러오기 실패</div>'; }
}

async function deleteChat(chatKey) {
  if (!confirm('이 채팅의 서버 기억(노드·관계·커뮤니티·원문 로그·잡 이력)을 전부 삭제합니다.\\n채팅 자체는 Risu에 그대로 남습니다.\\n\\n계속할까요?')) return;
  const purge = confirm('디스크 잔상까지 완전 소거(VACUUM)할까요?\\n(프라이버시 소거용 — 시간이 걸릴 수 있습니다. 보통은 취소를 눌러도 됩니다)');
  status('삭제 중…');
  try {
    const resp = await fetch('/api/chats/' + encodeURIComponent(chatKey) + (purge ? '?purge=true' : ''), { method: 'DELETE', headers });
    if (!resp.ok) { status('삭제 실패: HTTP ' + resp.status, 'err'); return; }
    status('삭제했습니다. 이후 이 채팅에서 메시지를 보내면 빈 기억으로 새로 시작합니다 (복사본 감지로 다른 채팅의 기억을 이어받을 수도 있음 — 원치 않으면 설정에서 챗 복사 승계를 끄세요).', 'ok');
    load();
  } catch (e) { status('삭제 실패: ' + e.message, 'err'); }
}

async function load() {
  if (!token) { status('토큰이 없습니다 — 설정 페이지를 먼저 열어 토큰을 입력하세요.', 'err'); return; }
  try {
    const h = await fetch('/api/health').then(r => r.json());
    $('ver').textContent = 'v' + h.version;
    const resp = await fetch('/api/chats', { headers });
    if (resp.status === 401) { status('토큰이 올바르지 않습니다 — 설정 페이지에서 다시 입력하세요.', 'err'); return; }
    const chats = await resp.json();
    const list = $('list');
    list.innerHTML = chats.length === 0 ? '<div class="meta empty">채팅 없음 — 플러그인을 설치하고 채팅을 시작하면 여기에 나타납니다.</div>' : '';
    for (const c of chats) {
      const card = document.createElement('div');
      card.className = 'card';
      const h3 = document.createElement('h3');
      h3.textContent = c.chatKey;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = '턴 ' + c.currentTurn + ' · 노드 ' + c.nodeCount + '개 · 메시지 ' + c.msgCount + '개 · ' + ago(c.updatedAt);
      const btns = document.createElement('div');
      btns.className = 'btns';
      const jbox = document.createElement('div');
      jbox.className = 'jobs';
      const mk = (label, fn, cls) => {
        const b = document.createElement('button');
        b.textContent = label; if (cls) b.className = cls;
        b.addEventListener('click', () => fn(b));
        btns.appendChild(b);
      };
      mk('잡 이력', (b) => toggleJobs(c.chatKey, jbox, b));
      mk('그래프', () => { location.href = '/graph?chatKey=' + encodeURIComponent(c.chatKey); });
      mk('주입 뷰어', () => { location.href = '/injection?chatKey=' + encodeURIComponent(c.chatKey); });
      mk('기억 삭제', () => deleteChat(c.chatKey), 'danger');
      card.appendChild(h3); card.appendChild(meta); card.appendChild(btns); card.appendChild(jbox);
      list.appendChild(card);
    }
    if (!$('status').textContent.includes('삭제')) status('');
  } catch (e) { status('불러오기 실패: ' + e.message, 'err'); }
}
load();
</script>
</body>
</html>`;
