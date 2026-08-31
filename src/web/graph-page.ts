// 그래프 뷰어 — RisuAI OmniNode ForceGraphEngine의 서버판 이식 (Phase 8c/8d).
// 토큰은 설정/대시보드와 localStorage 공유. 외부 라이브러리 없이 REST 노드를 렌더링한다.
import { THEME_CSS, THEME_SCRIPT } from './theme.js';

export const GRAPH_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>${THEME_SCRIPT}</script>
<title>OmniNode 그래프</title>
<style>
${THEME_CSS}
  body { max-width: none; }
  h1 { margin: 8px 0 4px; }
  h2, h3 { margin: 0; }
  button.active { border-color: var(--accent); background: var(--accent); color: var(--accent-contrast); }
  input[type="search"] { min-height: 36px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-deep); color: var(--text); font: inherit; }
  input[type="search"]::placeholder { color: var(--text-faint); opacity: 1; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  #chat-select { flex: 1 1 280px; min-width: 0; }
  #status { min-height: 20px; margin: 8px 4px; font-size: 0.8rem; font-weight: 500; line-height: 1.45; }
  .modebar { display: flex; align-items: center; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
  .modebar .stats { margin-left: auto; color: var(--text-faint); font-size: 0.74rem; font-variant-numeric: tabular-nums; }
  .viewer-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: start; }
  .view-panel, .detail { min-width: 0; }
  .view-panel { padding: 0; overflow: hidden; }
  .graph-toolbar, .list-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px; border-bottom: 1px solid var(--border); }
  .graph-toolbar input, .list-toolbar input { flex: 1 1 180px; min-width: 0; }
  .graph-frame { position: relative; height: clamp(380px, 68vh, 720px); background: var(--bg-deep); }
  #graph { position: relative; width: 100%; height: 100%; overflow: hidden; }
  .hint { padding: 8px 12px; border-top: 1px solid var(--border); }
  .detail { overflow: auto; max-height: none; }
  .detail.empty { min-height: 92px; display: grid; place-items: center; color: var(--text-faint); font-size: 0.8rem; text-align: center; }
  .detail-head { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
  .detail-dot { width: 12px; height: 12px; border-radius: 999px; flex: 0 0 auto; }
  .detail-title { overflow-wrap: anywhere; flex: 1; }
  .type-badge { white-space: nowrap; }
  .meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; margin-bottom: 12px; color: var(--text-dim); font-size: 0.74rem; font-variant-numeric: tabular-nums; }
  .meta-grid div { overflow-wrap: anywhere; }
  .detail-actions { display: flex; gap: 8px; align-items: center; margin: 0 0 12px; flex-wrap: wrap; }
  .detail-actions .pin-label { margin-right: auto; color: var(--text-faint); font-size: 0.74rem; }
  .edit-form { display: grid; gap: 12px; }
  .edit-field { display: grid; gap: 4px; min-width: 0; }
  .edit-field input, .edit-field textarea { width: 100%; min-width: 0; }
  .edit-field textarea { resize: vertical; min-height: 152px; line-height: 1.55; }
  .edit-numbers, .edit-checks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .edit-checks label { display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-deep); }
  .edit-checks input { margin: 0; }
  .edit-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .section-title { margin: 12px 0 4px; }
  .content-full { max-height: 42vh; margin: 0; padding: 8px; overflow: auto; border-radius: 8px; background: var(--bg-deep); color: var(--text); font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
  .link-list { display: grid; gap: 4px; }
  .node-link { width: 100%; text-align: left; overflow-wrap: anywhere; }
  .muted { color: var(--text-faint); font-size: 0.74rem; }
  #list-view { min-height: 380px; }
  .filters { display: flex; gap: 4px; flex-wrap: wrap; padding: 0 8px 8px; border-bottom: 1px solid var(--border); }
  .filters button { padding: 4px 8px; font-size: 0.74rem; }
  #node-list { max-height: 68vh; overflow: auto; }
  .node-row { width: 100%; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; border-width: 0 0 1px; border-radius: 0; background: var(--surface); text-align: left; }
  .node-dot { width: 12px; height: 12px; border-radius: 999px; }
  .node-main { min-width: 0; }
  .node-name { font-size: 0.92rem; font-weight: 700; overflow-wrap: anywhere; }
  .node-type { margin-top: 4px; }
  .node-score { color: var(--text-faint); font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.74rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .empty-list { padding: 32px 12px; color: var(--text-faint); text-align: center; }
  .detail-dot.node-lore, .node-dot.node-lore { background: var(--node-lore); }
  .detail-dot.node-extra, .node-dot.node-extra { background: var(--node-extra); }
  .detail-dot.node-ltm, .node-dot.node-ltm { background: var(--node-ltm); }
  .detail-dot.node-lines, .node-dot.node-lines { background: var(--node-lines); }
  .detail-dot.node-comm, .node-dot.node-comm { background: var(--node-comm); }
  .filters .node-lore, .node-link.node-lore { border-color: var(--node-lore); }
  .filters .node-extra, .node-link.node-extra { border-color: var(--node-extra); }
  .filters .node-ltm, .node-link.node-ltm { border-color: var(--node-ltm); }
  .filters .node-lines, .node-link.node-lines { border-color: var(--node-lines); }
  .filters .node-comm, .node-link.node-comm { border-color: var(--node-comm); }
  [hidden] { display: none !important; }
  @media (min-width: 880px) {
    .viewer-grid { grid-template-columns: minmax(0, 1fr) 320px; }
    .detail { max-height: calc(68vh + 96px); position: sticky; top: 12px; }
  }
  @media (max-width: 520px) {
    .controls { align-items: stretch; }
    .controls label { width: 100%; }
    .modebar .stats { width: 100%; margin-left: 4px; }
    .graph-frame { height: max(380px, 62vh); }
    .meta-grid { grid-template-columns: 1fr; }
    .edit-numbers { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<h1>🕸️ OmniNode 그래프</h1>
<nav class="topnav" aria-label="주요 메뉴">
  <a href="/settings">⚙️ 설정</a>
  <a href="/dashboard">📊 대시보드</a>
  <span class="current" aria-current="page">🕸️ 그래프</span>
  <a href="/injection">💉 주입 뷰어</a>
  <button type="button" class="theme-toggle" aria-label="테마 전환" onclick="toggleOmniNodeTheme()">☀️</button>
</nav>

<div class="controls panel">
  <label for="chat-select">채팅 선택</label>
  <select id="chat-select" aria-label="채팅 선택"><option value="">채팅 불러오는 중…</option></select>
  <button id="reload" type="button">새로고침</button>
</div>
<div id="status" role="status" aria-live="polite"></div>

<div class="modebar" aria-label="보기 방식">
  <button id="mode-graph" class="active" type="button">🔗 그래프</button>
  <button id="mode-list" type="button">📋 목록</button>
  <span id="stats" class="stats"></span>
</div>

<main class="viewer-grid">
  <section class="view-panel panel">
    <div id="graph-view">
      <div class="graph-toolbar">
        <input id="graph-search" type="search" placeholder="포커스할 노드 이름…" aria-label="그래프 노드 검색">
        <select id="graph-hops" aria-label="포커스 범위">
          <option value="0">전체 노드</option>
          <option value="1">1-hop</option>
          <option value="2" selected>2-hop</option>
        </select>
        <button id="fit" type="button">⊞ 맞춤</button>
        <button id="relayout" type="button">🔄 재배치</button>
        <button id="components" type="button">🧩 컴포넌트</button>
      </div>
      <div class="graph-frame"><div id="graph"></div></div>
      <div class="hint">노드 드래그 · 빈 공간 이동 · 휠/핀치 확대 · 노드 선택 시 2-hop 포커스</div>
    </div>

    <div id="list-view" hidden>
      <div class="list-toolbar">
        <input id="list-search" type="search" placeholder="이름, 키워드, 내용 검색…" aria-label="노드 검색">
        <select id="list-sort" aria-label="정렬">
          <option value="activation">활성도순</option>
          <option value="importance">중요도순</option>
          <option value="time">생성순</option>
        </select>
      </div>
      <div id="filters" class="filters"></div>
      <div id="node-list"></div>
    </div>
  </section>

  <aside id="detail" class="detail panel empty">노드를 선택하면 내용과 관계를 확인할 수 있습니다.</aside>
</main>

<script>
const GRAPH_OVERLAY = {
  mocha: {
    nodeFill: {
      default: 'rgba(30,30,50,0.6)',
      hover: 'rgba(40,40,65,0.7)',
      selected: 'rgba(50,50,80,0.8)'
    },
    edgeHopAlpha: { zero: 1.0, one: 0.6, two: 0.25, distant: 0.07 },
    nodeHopAlpha: { selected: 1.0, zero: 1.0, one: 0.7, two: 0.35, distant: 0.1 },
    nodeStrokeAlpha: 136 / 255,
    activationGlow: { threshold: 50, divisor: 100, maxAlpha: 0.3, blurRadius: 12, blurMultiplier: 3, colorAlpha: 1.0 }
  },
  latte: {
    nodeFill: {
      default: 'rgba(255,255,255,0.75)',
      hover: 'rgba(255,255,255,0.88)',
      selected: 'rgba(220,224,232,0.95)'
    },
    edgeHopAlpha: { zero: 1.0, one: 0.6, two: 0.25, distant: 0.07 },
    nodeHopAlpha: { selected: 1.0, zero: 1.0, one: 0.7, two: 0.35, distant: 0.1 },
    nodeStrokeAlpha: 136 / 255,
    activationGlow: { threshold: 50, divisor: 100, maxAlpha: 0.3, blurRadius: 12, blurMultiplier: 3, colorAlpha: 0.7 }
  }
};

function colorWithAlpha(color, alpha) {
  const value = color.trim();
  if (!value.startsWith('#') || value.length !== 7) throw new Error('그래프 색상 토큰 형식이 올바르지 않습니다.');
  const red = Number.parseInt(value.slice(1, 3), 16);
  const green = Number.parseInt(value.slice(3, 5), 16);
  const blue = Number.parseInt(value.slice(5, 7), 16);
  return 'rgba(' + red + ',' + green + ',' + blue + ',' + alpha + ')';
}

function resolvePalette() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name) => {
    const value = styles.getPropertyValue(name).trim();
    if (!value) throw new Error('그래프 색상 토큰이 없습니다: ' + name);
    return value;
  };
  const nodeTypes = {
    lore: read('--node-lore'),
    extraLore: read('--node-extra'),
    longTermMemory: read('--node-ltm'),
    communitySummary: read('--node-comm')
  };
  const edgeTokens = {
    causes: read('--edge-causes'),
    enables: read('--edge-enables'),
    prevents: read('--edge-prevents'),
    contradicts: read('--edge-contradicts'),
    develops: read('--edge-develops'),
    related: read('--edge-related'),
    parent: read('--edge-parent')
  };
  const edges = {};
  const edgesHover = {};
  for (const type of Object.keys(edgeTokens)) {
    edges[type] = colorWithAlpha(edgeTokens[type], type === 'related' ? 0.15 : 0.5);
    edgesHover[type] = colorWithAlpha(edgeTokens[type], type === 'related' ? 0.6 : 0.8);
  }
  const textFaint = read('--text-faint');
  return {
    theme: document.documentElement.dataset.theme === 'latte' ? 'latte' : 'mocha',
    background: read('--bg-deep'),
    text: read('--text'),
    textFaint: textFaint,
    accent: read('--accent'),
    star: read('--node-lines'),
    nodeTypes: nodeTypes,
    edges: edges,
    edgesHover: edgesHover,
    edgeFallback: {
      base: colorWithAlpha(edgeTokens.related, 0.12),
      hover: colorWithAlpha(edgeTokens.develops, 0.6),
      label: colorWithAlpha(textFaint, 0.9)
    },
    componentColors: [
      read('--accent'),
      read('--palette-pink'),
      read('--palette-sapphire'),
      read('--palette-green'),
      read('--palette-yellow'),
      read('--palette-peach'),
      read('--palette-red'),
      read('--palette-teal'),
      read('--palette-mauve'),
      read('--palette-blue'),
      read('--palette-lavender'),
      read('--palette-flamingo'),
      read('--palette-sky'),
      read('--palette-maroon'),
      read('--palette-rosewater')
    ]
  };
}

let GRAPH_PALETTE = resolvePalette();
const TYPE_NAMES = { lore: '로어', extraLore: '엔티티', longTermMemory: '장기 기억', communitySummary: '커뮤니티' };
const NODE_TYPE_CLASSES = { lore: 'node-lore', extraLore: 'node-extra', longTermMemory: 'node-ltm', communitySummary: 'node-comm' };
const SERIALIZED_NODE_KEYS = ['loreNodes', 'extraLoreNodes', 'communityNodes', 'longTermMemoryNodes'];

function nodeTypeClass(type) {
  return NODE_TYPE_CLASSES[type] || 'node-extra';
}

class ForceGraphEngine {
  constructor(containerEl) {
    this.container = containerEl;
    this.canvas = null;
    this.ctx = null;
    this.nodes = new Map();
    this.edges = [];
    this.width = 800;
    this.height = 500;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.animId = null;
    this.dragging = null;
    this.panning = false;
    this.panStart = { x: 0, y: 0 };
    this.hoveredNode = null;
    this.selectedNode = null;
    this.onNodeClick = null;
    this.onNodeDoubleClick = null;
    this.alpha = 1.0;
    this.alphaDecay = 0.0228;
    this.alphaMin = 0.001;
    this.initialized = false;
    this.componentColors = null;
    this._isMobile = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    this._frameCount = 0;
    this._settled = false;
    this.palette = GRAPH_PALETTE;
    this.overlay = GRAPH_OVERLAY[this.palette.theme];
    this.typeColors = this.palette.nodeTypes;
  }

  init() {
    if (this.initialized) return;
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.maxWidth = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.background = this.palette.background;
    this.canvas.style.borderRadius = '12px';
    this.canvas.style.border = '1px solid var(--border)';
    this.canvas.style.cursor = 'grab';
    this.canvas.style.touchAction = 'none';
    this.container.style.height = '100%';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this._resize();
    this._bindEvents();
    this.initialized = true;
  }

  applyPalette(palette) {
    this.palette = palette;
    this.overlay = GRAPH_OVERLAY[palette.theme];
    this.typeColors = palette.nodeTypes;
    if (this.canvas) this.canvas.style.background = palette.background;
    if (this.componentColors && this._componentGroups) this._resolveComponentColors();
  }

  destroy() {
    if (this.animId) cancelAnimationFrame(this.animId);
    this.animId = null;
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._listeners) {
      for (const item of this._listeners) {
        item.target.removeEventListener(item.event, item.handler, item.opts);
      }
      this._listeners = [];
    }
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.initialized = false;
  }

  _resize() {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const maxW = this.container.parentElement?.getBoundingClientRect()?.width || 900;
    const newW = Math.round(Math.min(rect.width || 900, maxW));
    const parentH = this.container.parentElement?.getBoundingClientRect()?.height || 0;
    const newH = parentH > 100 ? Math.round(parentH) : (newW < 500 ? Math.max(280, Math.round(newW * 0.65)) : 500);
    if (this._lastResizeW === newW && this._lastResizeH === newH) return;
    this._lastResizeW = newW;
    this._lastResizeH = newH;
    this.width = newW;
    this.height = newH;
    this.container.style.height = newH + 'px';
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = '100%';
    this.canvas.style.maxWidth = this.width + 'px';
    this.canvas.style.height = newH + 'px';
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  load(allNodes, randomize = false) {
    this.nodes.clear();
    this.edges = [];
    const angleStep = (2 * Math.PI) / Math.max(allNodes.length, 1);
    const radius = Math.min(this.width, this.height) * 0.1;
    for (let i = 0; i < allNodes.length; i++) {
      const n = allNodes[i];
      let x;
      let y;
      if (randomize) {
        x = 80 + Math.random() * (this.width - 160);
        y = 80 + Math.random() * (this.height - 160);
      } else {
        const angle = angleStep * i;
        x = this.width / 2 + radius * Math.cos(angle);
        y = this.height / 2 + radius * Math.sin(angle);
      }
      this.nodes.set(n.id, {
        id: n.id, x: x, y: y, vx: 0, vy: 0, fx: null, fy: null,
        pinned: false,
        name: n.name || (n.keywords || [])[0] || n.id.substring(0, 8),
        type: n.type,
        importance: n.importance || 3,
        activationScore: n.activationScore || 0,
        w: 0, h: 0
      });
    }
    const edgeSeen = new Set();
    for (const n of allNodes) {
      for (const r of (n.relationships || [])) {
        if (!this.nodes.has(r.targetId)) continue;
        const key = [n.id, r.targetId].sort().join('|');
        if (r.direction === 'bi' && edgeSeen.has(key)) continue;
        edgeSeen.add(key);
        this.edges.push({
          source: n.id, target: r.targetId,
          type: r.type || 'related', strength: (r.strength || 3) / 3, id: key,
          direction: r.direction || 'bi'
        });
      }
    }
    if (this.ctx) {
      this.ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
      for (const node of this.nodes.values()) {
        const tw = this.ctx.measureText(node.name).width;
        node.w = Math.max(tw + 32, 80);
        node.h = 36 + (node.importance - 3) * 2;
      }
    }
    this.alpha = 1.0;
    this._settled = false;
  }

  loadSubgraph(allNodes, nodeIdSet) {
    this.nodes.clear();
    this.edges = [];
    const subNodes = allNodes.filter((n) => nodeIdSet.has(n.id));
    const angleStep = (2 * Math.PI) / Math.max(subNodes.length, 1);
    const radius = Math.min(this.width, this.height) * 0.1;
    for (let i = 0; i < subNodes.length; i++) {
      const n = subNodes[i];
      const angle = angleStep * i;
      this.nodes.set(n.id, {
        id: n.id, x: this.width / 2 + radius * Math.cos(angle), y: this.height / 2 + radius * Math.sin(angle),
        vx: 0, vy: 0, fx: null, fy: null, pinned: false,
        name: n.name || (n.keywords || [])[0] || n.id.substring(0, 8),
        type: n.type, importance: n.importance || 3, activationScore: n.activationScore || 0, w: 0, h: 0
      });
    }
    const edgeSeen = new Set();
    for (const n of subNodes) {
      for (const r of (n.relationships || [])) {
        if (!this.nodes.has(r.targetId)) continue;
        const key = [n.id, r.targetId].sort().join('|');
        if (r.direction === 'bi' && edgeSeen.has(key)) continue;
        edgeSeen.add(key);
        this.edges.push({ source: n.id, target: r.targetId, type: r.type || 'related', strength: (r.strength || 3) / 3, id: key, direction: r.direction || 'bi' });
      }
    }
    if (this.ctx) {
      this.ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
      for (const node of this.nodes.values()) {
        const tw = this.ctx.measureText(node.name).width;
        node.w = Math.max(tw + 32, 80);
        node.h = 36 + (node.importance - 3) * 2;
      }
    }
    this.alpha = 1.0;
    this._settled = false;
  }

  update(allNodes) {
    const newIds = new Set(allNodes.map((n) => n.id));
    for (const id of Array.from(this.nodes.keys())) {
      if (!newIds.has(id)) this.nodes.delete(id);
    }
    for (const n of allNodes) {
      if (!this.nodes.has(n.id)) {
        const x = this.width / 2 + (Math.random() - 0.5) * 100;
        const y = this.height / 2 + (Math.random() - 0.5) * 100;
        const gNode = {
          id: n.id, x: x, y: y, vx: 0, vy: 0, fx: null, fy: null,
          pinned: false,
          name: n.name || (n.keywords || [])[0] || n.id.substring(0, 8),
          type: n.type,
          importance: n.importance || 3,
          activationScore: n.activationScore || 0,
          w: 0, h: 0
        };
        if (this.ctx) {
          this.ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
          const tw = this.ctx.measureText(gNode.name).width;
          gNode.w = Math.max(tw + 32, 80);
          gNode.h = 36 + (gNode.importance - 3) * 2;
        }
        this.nodes.set(n.id, gNode);
      } else {
        const existing = this.nodes.get(n.id);
        const newName = n.name || (n.keywords || [])[0] || n.id.substring(0, 8);
        if (existing.name !== newName) {
          existing.name = newName;
          if (this.ctx) {
            this.ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
            existing.w = Math.max(this.ctx.measureText(newName).width + 32, 80);
          }
        }
        existing.importance = n.importance || 3;
        existing.activationScore = n.activationScore || 0;
        existing.h = 36 + (existing.importance - 3) * 2;
      }
    }
    this.edges = [];
    const edgeSeen = new Set();
    for (const n of allNodes) {
      for (const r of (n.relationships || [])) {
        if (!this.nodes.has(r.targetId)) continue;
        const key = [n.id, r.targetId].sort().join('|');
        if (r.direction === 'bi' && edgeSeen.has(key)) continue;
        edgeSeen.add(key);
        this.edges.push({
          source: n.id, target: r.targetId,
          type: r.type || 'related', strength: (r.strength || 3) / 3, id: key,
          direction: r.direction || 'bi'
        });
      }
    }
    if (this.alpha < 0.3) this.alpha = 0.3;
    this._settled = false;
    if (!this.animId) this.start();
  }

  _tick() {
    if (this.alpha < this.alphaMin) return;
    const nodes = Array.from(this.nodes.values());
    const k = 35;
    const springLen = 50;
    const springK = 0.08;
    const gravityK = 0.06;
    const cx = this.width / 2;
    const cy = this.height / 2;
    for (const n of nodes) { n.vx *= 0.5; n.vy *= 0.5; }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = (a.w + b.w) / 2 + 20;
        const effectiveDist = Math.max(dist, minDist * 0.5);
        const force = k * k / effectiveDist;
        const fx = (dx / dist) * force * this.alpha;
        const fy = (dy / dist) * force * this.alpha;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    for (const edge of this.edges) {
      const a = this.nodes.get(edge.source);
      const b = this.nodes.get(edge.target);
      if (!a || !b) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const displacement = dist - springLen;
      const force = springK * displacement * edge.strength * this.alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    for (const n of nodes) {
      if (n.pinned) continue;
      n.vx += (cx - n.x) * gravityK * this.alpha;
      n.vy += (cy - n.y) * gravityK * this.alpha;
    }
    for (const n of nodes) {
      if (n.pinned) {
        n.x = n.fx ?? n.x;
        n.y = n.fy ?? n.y;
        continue;
      }
      const maxV = 30;
      n.vx = Math.max(-maxV, Math.min(maxV, n.vx));
      n.vy = Math.max(-maxV, Math.min(maxV, n.vy));
      n.x += n.vx;
      n.y += n.vy;
    }
    this.alpha = Math.max(this.alpha - this.alphaDecay, 0);
  }

  _render() {
    const ctx = this.ctx;
    if (!ctx) return;
    const palette = this.palette;
    const overlay = this.overlay;
    ctx.save();
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);
    const vpLeft = -this.offsetX / this.scale;
    const vpTop = -this.offsetY / this.scale;
    const vpRight = vpLeft + this.width / this.scale;
    const vpBottom = vpTop + this.height / this.scale;
    const pad = 100;
    const inView = (x, y, hw, hh) =>
      x + hw > vpLeft - pad && x - hw < vpRight + pad &&
      y + hh > vpTop - pad && y - hh < vpBottom + pad;

    let hopDist = null;
    if (this.selectedNode && this.nodes.has(this.selectedNode)) {
      hopDist = new Map();
      hopDist.set(this.selectedNode, 0);
      let frontier = [this.selectedNode];
      for (let hop = 1; hop <= 2; hop++) {
        const next = [];
        for (const nid of frontier) {
          for (const edge of this.edges) {
            const neighbor = edge.source === nid ? edge.target : (edge.target === nid ? edge.source : null);
            if (neighbor && !hopDist.has(neighbor)) {
              hopDist.set(neighbor, hop);
              next.push(neighbor);
            }
          }
        }
        frontier = next;
      }
    }

    const showLabels = this.scale >= 0.45;
    for (const edge of this.edges) {
      const a = this.nodes.get(edge.source);
      const b = this.nodes.get(edge.target);
      if (!a || !b) continue;
      if (!inView((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2 + 50, Math.abs(b.y - a.y) / 2 + 50)) continue;
      if (hopDist) {
        const hA = hopDist.has(edge.source) ? hopDist.get(edge.source) : 99;
        const hB = hopDist.has(edge.target) ? hopDist.get(edge.target) : 99;
        const minH = Math.min(hA, hB);
        ctx.globalAlpha = minH === 0 ? overlay.edgeHopAlpha.zero : minH === 1 ? overlay.edgeHopAlpha.one : minH === 2 ? overlay.edgeHopAlpha.two : overlay.edgeHopAlpha.distant;
      }
      const isHovered = this.hoveredNode && (edge.source === this.hoveredNode || edge.target === this.hoveredNode);
      ctx.strokeStyle = isHovered ? (palette.edgesHover[edge.type] || palette.edgeFallback.hover) : (palette.edges[edge.type] || palette.edgeFallback.base);
      const strengthWidth = 0.5 + edge.strength * 1.0;
      ctx.lineWidth = isHovered ? Math.max(strengthWidth, 2.5) : strengthWidth;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (edge.direction === 'uni') {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const tipDist = Math.max(dist - b.w / 2 - 4, dist * 0.5);
        const tipX = a.x + ux * tipDist;
        const tipY = a.y + uy * tipDist;
        const arrowLen = 10;
        const arrowW = 5;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - ux * arrowLen + uy * arrowW, tipY - uy * arrowLen - ux * arrowW);
        ctx.lineTo(tipX - ux * arrowLen - uy * arrowW, tipY - uy * arrowLen + ux * arrowW);
        ctx.closePath();
        ctx.fill();
      }
      if (showLabels && isHovered) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillStyle = palette.edgeFallback.label;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const rawStr = Math.round(edge.strength * 3);
        const label = edge.direction === 'uni' ? edge.type + ' (' + rawStr + ') →' : edge.type + ' (' + rawStr + ')';
        ctx.fillText(label, mx, my - 8);
      }
      if (hopDist) ctx.globalAlpha = 1.0;
    }

    for (const node of this.nodes.values()) {
      if (!inView(node.x, node.y, node.w / 2, node.h / 2)) continue;
      const color = this.componentColors ? (this.componentColors.get(node.id) || palette.textFaint) : (this.typeColors[node.type] || palette.textFaint);
      const isSelected = this.selectedNode === node.id;
      const isHovered = this.hoveredNode === node.id;
      const r = 8;
      if (hopDist) {
        const h = hopDist.has(node.id) ? hopDist.get(node.id) : 99;
        ctx.globalAlpha = isSelected ? overlay.nodeHopAlpha.selected : h === 0 ? overlay.nodeHopAlpha.zero : h === 1 ? overlay.nodeHopAlpha.one : h === 2 ? overlay.nodeHopAlpha.two : overlay.nodeHopAlpha.distant;
      }
      if (node.activationScore > overlay.activationGlow.threshold) {
        const glowAlpha = Math.min((node.activationScore - overlay.activationGlow.threshold) / overlay.activationGlow.divisor, overlay.activationGlow.maxAlpha);
        ctx.shadowColor = colorWithAlpha(color, overlay.activationGlow.colorAlpha);
        ctx.shadowBlur = overlay.activationGlow.blurRadius * glowAlpha * overlay.activationGlow.blurMultiplier;
      }
      ctx.fillStyle = isSelected ? overlay.nodeFill.selected : (isHovered ? overlay.nodeFill.hover : overlay.nodeFill.default);
      ctx.strokeStyle = isSelected ? color : (isHovered ? color : colorWithAlpha(color, overlay.nodeStrokeAlpha));
      ctx.lineWidth = isSelected ? 2.5 : (isHovered ? 2 : 1.5);
      this._roundRect(ctx, node.x - node.w / 2, node.y - node.h / 2, node.w, node.h, r);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (node.importance >= 4) {
        ctx.fillStyle = palette.star;
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.importance === 5 ? '★★' : '★', node.x - node.w / 2 + 5, node.y - node.h / 2 + 8);
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x - node.w / 2 + 12, node.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = isSelected || isHovered ? palette.text : palette.accent;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.name, node.x - node.w / 2 + 22, node.y);
      if (hopDist) ctx.globalAlpha = 1.0;
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this._componentInfo && this.componentColors) {
      const comps = this._componentInfo;
      const rows = Math.min(comps.length, 10);
      const lh = rows * 16 + 10;
      const lx = 10;
      const ly = this.height - lh - 5;
      ctx.fillStyle = palette.background;
      this._roundRect(ctx, lx, ly, 160, lh, 8);
      ctx.fill();
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      for (let i = 0; i < rows; i++) {
        ctx.fillStyle = comps[i].color;
        ctx.beginPath();
        ctx.arc(lx + 12, ly + 12 + i * 16, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = palette.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('Group ' + (i + 1) + ' (' + comps[i].size + ' node' + (comps[i].size > 1 ? 's' : '') + ')', lx + 22, ly + 12 + i * 16);
      }
      if (comps.length > 10) {
        ctx.fillStyle = palette.textFaint;
        ctx.fillText('+' + (comps.length - 10) + ' more...', lx + 22, ly + 12 + rows * 16);
      }
    } else {
      const lx = 10;
      const legend = [[palette.nodeTypes.lore, 'Lore'], [palette.nodeTypes.extraLore, 'Entity'], [palette.nodeTypes.longTermMemory, 'Memory'], [palette.nodeTypes.communitySummary, 'Community']];
      const lh = legend.length * 16 + 10;
      const ly = this.height - lh - 5;
      ctx.fillStyle = palette.background;
      this._roundRect(ctx, lx, ly, 140, lh, 8);
      ctx.fill();
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      legend.forEach((item, i) => {
        ctx.fillStyle = item[0];
        ctx.beginPath();
        ctx.arc(lx + 12, ly + 12 + i * 16, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = palette.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(item[1], lx + 22, ly + 12 + i * 16);
      });
    }
    ctx.restore();
    ctx.restore();
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  start() {
    if (this.animId) return;
    this._settled = false;
    const loop = () => {
      this._frameCount++;
      if (this._isMobile && (this._frameCount & 1)) {
        this._render();
        this.animId = requestAnimationFrame(loop);
        return;
      }
      this._tick();
      this._render();
      if (this.alpha < this.alphaMin && !this.dragging && !this.panning) {
        this._settled = true;
        this.animId = null;
        return;
      }
      this.animId = requestAnimationFrame(loop);
    };
    this.animId = requestAnimationFrame(loop);
  }

  _wake(minAlpha = 0.1) {
    this.alpha = Math.max(this.alpha, minAlpha);
    this._settled = false;
    if (!this.animId) this.start();
  }

  stop() {
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  _screenToGraph(sx, sy) {
    return { x: (sx - this.offsetX) / this.scale, y: (sy - this.offsetY) / this.scale };
  }

  _nodeAt(gx, gy) {
    for (const node of this.nodes.values()) {
      const hw = node.w / 2;
      const hh = node.h / 2;
      if (gx >= node.x - hw && gx <= node.x + hw && gy >= node.y - hh && gy <= node.y + hh) return node;
    }
    return null;
  }

  _bindEvents() {
    const c = this.canvas;
    let lastClick = 0;
    this._listeners = [];
    const addListener = (target, event, handler, opts) => {
      target.addEventListener(event, handler, opts);
      this._listeners.push({ target: target, event: event, handler: handler, opts: opts });
    };
    const touchXY = (touch) => {
      const rect = c.getBoundingClientRect();
      return { sx: touch.clientX - rect.left, sy: touch.clientY - rect.top };
    };
    const pinchDist = (t1, t2) => {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    let pinching = false;
    let lastPinchDist = 0;
    let lastPinchCenter = { x: 0, y: 0 };

    addListener(c, 'mousedown', (e) => {
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const point = this._screenToGraph(sx, sy);
      const node = this._nodeAt(point.x, point.y);
      if (node) {
        this.dragging = node;
        node.fx = node.x;
        node.fy = node.y;
        c.style.cursor = 'grabbing';
        this._wake(0.3);
        const now = Date.now();
        if (now - lastClick < 350 && this.selectedNode === node.id && this.onNodeDoubleClick) this.onNodeDoubleClick(node.id);
        lastClick = now;
        this.selectedNode = node.id;
        if (this.onNodeClick) this.onNodeClick(node.id);
      } else {
        this.panning = true;
        this.panStart = { x: e.clientX, y: e.clientY };
        c.style.cursor = 'grabbing';
        this.selectedNode = null;
        if (this.onNodeClick) this.onNodeClick(null);
      }
    });

    addListener(c, 'mousemove', (e) => {
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (this.dragging) {
        const point = this._screenToGraph(sx, sy);
        this.dragging.x = point.x;
        this.dragging.y = point.y;
        this.dragging.fx = point.x;
        this.dragging.fy = point.y;
        this._wake(0.1);
      } else if (this.panning) {
        this.offsetX += e.clientX - this.panStart.x;
        this.offsetY += e.clientY - this.panStart.y;
        this.panStart = { x: e.clientX, y: e.clientY };
        if (this._settled) { this._settled = false; this.start(); }
      } else {
        const point = this._screenToGraph(sx, sy);
        const node = this._nodeAt(point.x, point.y);
        this.hoveredNode = node ? node.id : null;
        c.style.cursor = node ? 'pointer' : 'grab';
      }
    });

    const endDrag = () => {
      if (this.dragging && !this.dragging.pinned) {
        this.dragging.fx = null;
        this.dragging.fy = null;
      }
      this.dragging = null;
      this.panning = false;
      c.style.cursor = 'grab';
    };
    addListener(c, 'mouseup', endDrag);
    addListener(c, 'mouseleave', endDrag);

    addListener(c, 'wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.max(0.2, Math.min(5, this.scale * delta));
      this.offsetX = sx - (sx - this.offsetX) * (newScale / this.scale);
      this.offsetY = sy - (sy - this.offsetY) * (newScale / this.scale);
      this.scale = newScale;
      if (this._settled) { this._settled = false; this.start(); }
    }, { passive: false });

    addListener(c, 'touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        pinching = true;
        this.dragging = null;
        this.panning = false;
        lastPinchDist = pinchDist(e.touches[0], e.touches[1]);
        const rect = c.getBoundingClientRect();
        lastPinchCenter = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
        };
        return;
      }
      if (e.touches.length !== 1) return;
      const screen = touchXY(e.touches[0]);
      const point = this._screenToGraph(screen.sx, screen.sy);
      const node = this._nodeAt(point.x, point.y);
      if (node) {
        this.dragging = node;
        node.fx = node.x;
        node.fy = node.y;
        this._wake(0.3);
        const now = Date.now();
        if (now - lastClick < 350 && this.selectedNode === node.id && this.onNodeDoubleClick) this.onNodeDoubleClick(node.id);
        lastClick = now;
        this.selectedNode = node.id;
        if (this.onNodeClick) this.onNodeClick(node.id);
      } else {
        this.panning = true;
        this.panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this.selectedNode = null;
        if (this.onNodeClick) this.onNodeClick(null);
      }
    }, { passive: false });

    addListener(c, 'touchmove', (e) => {
      e.preventDefault();
      if (pinching && e.touches.length === 2) {
        const dist = pinchDist(e.touches[0], e.touches[1]);
        const rect = c.getBoundingClientRect();
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        const ratio = dist / (lastPinchDist || 1);
        const newScale = Math.max(0.2, Math.min(5, this.scale * ratio));
        this.offsetX = cx - (cx - this.offsetX) * (newScale / this.scale);
        this.offsetY = cy - (cy - this.offsetY) * (newScale / this.scale);
        this.scale = newScale;
        lastPinchDist = dist;
        lastPinchCenter = { x: cx, y: cy };
        if (this._settled) { this._settled = false; this.start(); }
        return;
      }
      if (e.touches.length !== 1) return;
      const screen = touchXY(e.touches[0]);
      if (this.dragging) {
        const point = this._screenToGraph(screen.sx, screen.sy);
        this.dragging.x = point.x;
        this.dragging.y = point.y;
        this.dragging.fx = point.x;
        this.dragging.fy = point.y;
        this._wake(0.1);
      } else if (this.panning) {
        this.offsetX += e.touches[0].clientX - this.panStart.x;
        this.offsetY += e.touches[0].clientY - this.panStart.y;
        this.panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (this._settled) { this._settled = false; this.start(); }
      }
    }, { passive: false });

    addListener(c, 'touchend', (e) => {
      if (e.touches.length === 0) {
        pinching = false;
        endDrag();
      } else if (e.touches.length === 1) {
        pinching = false;
      }
    });
    addListener(c, 'touchcancel', () => {
      pinching = false;
      endDrag();
    });

    if (typeof ResizeObserver !== 'undefined') {
      let roRaf = null;
      this._resizeObserver = new ResizeObserver((entries) => {
        const cr = entries[0]?.contentRect;
        if (!cr) return;
        const w = Math.round(cr.width);
        if (this._lastObservedW === w) return;
        this._lastObservedW = w;
        if (roRaf) cancelAnimationFrame(roRaf);
        roRaf = requestAnimationFrame(() => {
          this._resize();
          this._render();
        });
      });
      this._resizeObserver.observe(this.container);
    }
  }

  computeComponents() {
    const adj = new Map();
    for (const id of this.nodes.keys()) adj.set(id, []);
    for (const e of this.edges) {
      if (adj.has(e.source) && adj.has(e.target)) {
        adj.get(e.source).push(e.target);
        adj.get(e.target).push(e.source);
      }
    }
    const visited = new Set();
    const components = [];
    for (const id of this.nodes.keys()) {
      if (visited.has(id)) continue;
      const comp = [];
      const queue = [id];
      visited.add(id);
      while (queue.length) {
        const cur = queue.shift();
        comp.push(cur);
        for (const nb of adj.get(cur) || []) {
          if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
        }
      }
      components.push(comp);
    }
    return components;
  }

  setComponentColoring() {
    const components = this.computeComponents();
    components.sort((a, b) => b.length - a.length);
    this._componentGroups = components;
    this._resolveComponentColors();
    this._render();
  }

  _resolveComponentColors() {
    const palette = this.palette.componentColors;
    this.componentColors = new Map();
    for (let i = 0; i < this._componentGroups.length; i++) {
      const color = palette[i % palette.length];
      for (const id of this._componentGroups[i]) this.componentColors.set(id, color);
    }
    this._componentInfo = this._componentGroups.map((c, i) => ({ size: c.length, color: palette[i % palette.length] }));
  }

  clearComponentColoring() {
    this.componentColors = null;
    this._componentGroups = null;
    this._componentInfo = null;
    this._render();
  }

  fitView() {
    const nodes = Array.from(this.nodes.values());
    if (nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2);
      maxX = Math.max(maxX, n.x + n.w / 2);
      maxY = Math.max(maxY, n.y + n.h / 2);
    }
    const pad = 30;
    const gw = maxX - minX + pad * 2;
    const gh = maxY - minY + pad * 2;
    this.scale = Math.min(this.width / gw, this.height / gh, 5);
    this.offsetX = (this.width - gw * this.scale) / 2 - minX * this.scale + pad * this.scale;
    this.offsetY = (this.height - gh * this.scale) / 2 - minY * this.scale + pad * this.scale;
  }
}

const byId = (id) => document.getElementById(id);
const token = localStorage.getItem('omninode_token') || '';
const headers = { 'Authorization': 'Bearer ' + token };
let allNodes = [];
let nodeById = new Map();
let selectedNodeId = null;
let graphEngine = null;
let viewMode = 'graph';
let listFilter = 'all';
let graphFilterTimer = null;

const themeObserver = new MutationObserver((records) => {
  if (!records.some((record) => record.attributeName === 'data-theme')) return;
  GRAPH_PALETTE = resolvePalette();
  if (graphEngine) {
    graphEngine.applyPalette(GRAPH_PALETTE);
    graphEngine._render();
  }
});
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

function setStatus(message, cls) {
  byId('status').textContent = message;
  byId('status').className = cls || '';
}

function nodeName(node) {
  if (!node) return '알 수 없는 노드';
  return node.name || (node.keywords || [])[0] || String(node.id || '').substring(0, 8);
}

function normalizeNodes(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const result = [];
  for (const key of SERIALIZED_NODE_KEYS) {
    if (Array.isArray(value[key])) result.push.apply(result, value[key]);
  }
  return result;
}

function addText(parent, tag, text, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function makeNodeLink(node, prefix) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'node-link ' + nodeTypeClass(node.type);
  button.dataset.nodeId = node.id;
  button.textContent = (prefix || '') + nodeName(node);
  return button;
}

function resetDetail() {
  const detail = byId('detail');
  detail.className = 'detail panel empty';
  detail.textContent = '노드를 선택하면 내용과 관계를 확인할 수 있습니다.';
}

function makeEditField(labelText, name, value, options) {
  const field = document.createElement('div');
  field.className = 'edit-field';
  const id = 'node-edit-' + name;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  field.appendChild(label);
  const input = document.createElement(options && options.textarea ? 'textarea' : 'input');
  input.id = id;
  input.name = name;
  input.value = value == null ? '' : String(value);
  if (options && options.textarea) {
    input.rows = 8;
  } else {
    input.type = options && options.type ? options.type : 'text';
    if (options && options.min != null) input.min = String(options.min);
    if (options && options.max != null) input.max = String(options.max);
    if (options && options.step != null) input.step = String(options.step);
    if (options && options.required) input.required = true;
  }
  field.appendChild(input);
  return field;
}

function makeEditCheckbox(labelText, name, checked) {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = name;
  input.checked = !!checked;
  label.appendChild(input);
  label.appendChild(document.createTextNode(labelText));
  return label;
}

function renderEditForm(nodeId) {
  const node = nodeById.get(nodeId);
  if (!node) { resetDetail(); return; }
  const detail = byId('detail');
  detail.className = 'detail panel';
  detail.replaceChildren();

  const typeClass = nodeTypeClass(node.type);
  const head = document.createElement('div');
  head.className = 'detail-head';
  const dot = document.createElement('span');
  dot.className = 'detail-dot ' + typeClass;
  head.appendChild(dot);
  addText(head, 'h2', nodeName(node) + ' 편집', 'detail-title');
  addText(head, 'span', TYPE_NAMES[node.type] || node.type || '기타', 'type-badge node-chip ' + typeClass);
  detail.appendChild(head);

  const form = document.createElement('form');
  form.className = 'edit-form';
  form.dataset.nodeEditForm = 'true';
  form.dataset.editNodeId = node.id; // data-node-id는 상세 패널의 링크 내비게이션 셀렉터와 충돌 (터치 시 편집 이탈 버그)
  form.appendChild(makeEditField('이름', 'name', node.name || ''));
  form.appendChild(makeEditField('내용', 'content', node.content || '', { textarea: true }));
  form.appendChild(makeEditField('키워드 (쉼표 구분)', 'keywords', (node.keywords || []).join(', ')));
  form.appendChild(makeEditField('전역 키워드 (쉼표 구분)', 'globalKeywords', (node.globalKeywords || []).join(', ')));

  const numbers = document.createElement('div');
  numbers.className = 'edit-numbers';
  numbers.appendChild(makeEditField('중요도', 'importance', node.importance ?? 3, { type: 'number', min: 1, max: 5, step: 1, required: true }));
  // 활성도는 EMA 무한소수가 정상값 — step 배수 검증(0.1)을 걸면 프리필부터 invalid라 제출 불가. 'any' 필수.
  // lore는 서버 updateNode가 활성도를 무시하므로(원작 의미론) 칸 자체를 숨김.
  if (node.type !== 'lore') {
    numbers.appendChild(makeEditField('활성도', 'activationScore', node.activationScore ?? 0, { type: 'number', min: 0, max: 100, step: 'any', required: true }));
  }
  form.appendChild(numbers);

  if (node.type === 'longTermMemory' || node.type === 'communitySummary') {
    form.appendChild(makeEditField('타임스탬프', 'timestamp', node.timestamp || ''));
  }

  const checks = document.createElement('div');
  checks.className = 'edit-checks';
  checks.appendChild(makeEditCheckbox('🗄️ 보관됨', 'archived', node.archived));
  checks.appendChild(makeEditCheckbox('⛔ 제외됨', 'excluded', node.excluded));
  form.appendChild(checks);

  const buttons = document.createElement('div');
  buttons.className = 'edit-buttons';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.dataset.detailAction = 'cancel-edit';
  cancel.textContent = '취소';
  buttons.appendChild(cancel);
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'active';
  save.textContent = '저장';
  buttons.appendChild(save);
  form.appendChild(buttons);
  detail.appendChild(form);
}

async function patchNode(nodeId, patch) {
  const chatKey = byId('chat-select').value;
  if (!chatKey) throw new Error('선택된 채팅이 없습니다.');
  const response = await fetch(
    '/api/chats/' + encodeURIComponent(chatKey) + '/nodes/' + encodeURIComponent(nodeId),
    {
      method: 'PATCH',
      headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(patch)
    }
  );
  let data = null;
  try { data = await response.json(); } catch {}
  if (response.status === 401) throw new Error('토큰이 올바르지 않습니다.');
  if (!response.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + response.status);
  if (!data || data.id !== nodeId) throw new Error('서버가 수정된 노드를 반환하지 않았습니다.');
  return data;
}

async function deleteNode(nodeId) {
  const chatKey = byId('chat-select').value;
  if (!chatKey) throw new Error('선택된 채팅이 없습니다.');
  const response = await fetch(
    '/api/chats/' + encodeURIComponent(chatKey) + '/nodes/' + encodeURIComponent(nodeId),
    { method: 'DELETE', headers: headers }
  );
  let data = null;
  try { data = await response.json(); } catch {}
  if (response.status === 401) throw new Error('토큰이 올바르지 않습니다.');
  if (!response.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + response.status);
  if (!data || data.ok !== true || data.removedId !== nodeId) throw new Error('서버가 삭제 결과를 반환하지 않았습니다.');
}

function applyUpdatedNode(node) {
  const index = allNodes.findIndex((candidate) => candidate.id === node.id);
  if (index < 0) return;
  allNodes[index] = node;
  nodeById.set(node.id, node);
  if (graphEngine && graphEngine.initialized) graphEngine.update(allNodes);
  renderList();
}

function splitKeywords(value) {
  return String(value || '').split(',').map((keyword) => keyword.trim()).filter(Boolean);
}

function renderDetail(nodeId) {
  const node = nodeById.get(nodeId);
  if (!node) { resetDetail(); return; }
  const detail = byId('detail');
  detail.className = 'detail panel';
  detail.replaceChildren();

  const typeClass = nodeTypeClass(node.type);
  const head = document.createElement('div');
  head.className = 'detail-head';
  const dot = document.createElement('span');
  dot.className = 'detail-dot ' + typeClass;
  head.appendChild(dot);
  addText(head, 'h2', nodeName(node), 'detail-title');
  addText(head, 'span', TYPE_NAMES[node.type] || node.type || '기타', 'type-badge node-chip ' + typeClass);
  detail.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'meta-grid';
  const metaRows = [
    '★ 중요도 ' + (node.importance ?? 0) + '/5',
    '⚡ 활성도 ' + Number(node.activationScore || 0).toFixed(1),
    '🎯 유틸리티 ' + Number(node.utilityScore ?? 50).toFixed(1),
    '📅 생성 턴 ' + (node.creationTurn ?? '?'),
    '🆔 ' + node.id,
    node.timestamp ? '🕒 ' + node.timestamp : '',
    node.alwaysActive ? '📌 항상 활성' : '',
    node.archived ? '🗄️ 보관됨' : '',
    node.excluded ? '⛔ 제외됨' : ''
  ].filter(Boolean);
  for (const row of metaRows) addText(meta, 'div', row);
  detail.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.dataset.detailAction = 'toggle-pin';
  pin.dataset.nodeId = node.id;
  pin.classList.toggle('active', !!node.alwaysActive);
  pin.setAttribute('aria-pressed', node.alwaysActive ? 'true' : 'false');
  pin.textContent = node.alwaysActive ? '📌 핀 해제' : '📌 핀 고정';
  actions.appendChild(pin);
  addText(actions, 'span', node.alwaysActive ? '항상 활성' : '일반', 'pin-label');
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.dataset.detailAction = 'edit';
  edit.dataset.nodeId = node.id;
  edit.textContent = '✏️ 편집';
  actions.appendChild(edit);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.dataset.detailAction = 'delete';
  remove.dataset.nodeId = node.id;
  remove.textContent = '🗑️ 삭제';
  actions.appendChild(remove);
  detail.appendChild(actions);

  if ((node.keywords || []).length) {
    addText(detail, 'div', '키워드', 'section-title');
    addText(detail, 'div', node.keywords.join(', '), 'muted');
  }
  if ((node.globalKeywords || []).length) {
    addText(detail, 'div', '전역 키워드', 'section-title');
    addText(detail, 'div', node.globalKeywords.join(', '), 'muted');
  }

  addText(detail, 'div', '내용', 'section-title');
  const content = document.createElement('pre');
  content.className = 'content-full';
  content.textContent = node.content || '(내용 없음)';
  detail.appendChild(content);

  addText(detail, 'div', '관계 (' + (node.relationships || []).length + ')', 'section-title');
  const relList = document.createElement('div');
  relList.className = 'link-list';
  for (const rel of (node.relationships || [])) {
    const target = nodeById.get(rel.targetId);
    if (target) {
      const direction = rel.direction === 'uni' ? '→ ' : '↔ ';
      relList.appendChild(makeNodeLink(target, direction + '[' + (rel.type || 'related') + ' · ' + (rel.strength ?? 3) + '/5] '));
    } else {
      addText(relList, 'div', '→ [' + (rel.type || 'related') + '] ' + rel.targetId, 'muted');
    }
  }
  if (!(node.relationships || []).length) addText(relList, 'div', '관계 없음', 'muted');
  detail.appendChild(relList);

  const memberships = allNodes.filter((candidate) =>
    candidate.type === 'communitySummary' &&
    ((candidate.memberNodeIds || []).includes(node.id) || (node.parentCommunityId && candidate.communityId === node.parentCommunityId))
  );
  if (memberships.length) {
    addText(detail, 'div', '소속 커뮤니티', 'section-title');
    const membershipList = document.createElement('div');
    membershipList.className = 'link-list';
    for (const community of memberships) membershipList.appendChild(makeNodeLink(community, '◉ '));
    detail.appendChild(membershipList);
  }

  if (node.type === 'communitySummary') {
    if (node.parentCommunityId) {
      const parent = allNodes.find((candidate) => candidate.type === 'communitySummary' && candidate.communityId === node.parentCommunityId);
      if (parent) {
        addText(detail, 'div', '상위 커뮤니티', 'section-title');
        const parentList = document.createElement('div');
        parentList.className = 'link-list';
        parentList.appendChild(makeNodeLink(parent, '↑ '));
        detail.appendChild(parentList);
      }
    }
    addText(detail, 'div', '멤버 (' + (node.memberNodeIds || []).length + ')', 'section-title');
    const memberList = document.createElement('div');
    memberList.className = 'link-list';
    for (const memberId of (node.memberNodeIds || [])) {
      const member = nodeById.get(memberId);
      if (member) memberList.appendChild(makeNodeLink(member, '• '));
      else addText(memberList, 'div', memberId, 'muted');
    }
    if (!(node.memberNodeIds || []).length) addText(memberList, 'div', '멤버 없음', 'muted');
    detail.appendChild(memberList);
  }
}

function focusGraphNode(nodeId) {
  if (!graphEngine) return;
  graphEngine.selectedNode = nodeId;
  const graphNode = graphEngine.nodes.get(nodeId);
  if (graphNode) {
    graphEngine.offsetX = graphEngine.width / 2 - graphNode.x * graphEngine.scale;
    graphEngine.offsetY = graphEngine.height / 2 - graphNode.y * graphEngine.scale;
  }
  graphEngine._render();
}

function selectNode(nodeId, center) {
  if (!nodeById.has(nodeId)) return;
  selectedNodeId = nodeId;
  renderDetail(nodeId);
  if (graphEngine) {
    graphEngine.selectedNode = nodeId;
    if (center) focusGraphNode(nodeId);
    else graphEngine._render();
  }
  updateListSelection();
}

function renderFilters() {
  const filters = byId('filters');
  filters.replaceChildren();
  const types = [
    ['all', '전체'], ['lore', '로어'], ['extraLore', '엔티티'],
    ['communitySummary', '커뮤니티'], ['longTermMemory', '장기 기억']
  ];
  const counts = new Map(types.map((item) => [
    item[0],
    item[0] === 'all' ? allNodes.length : allNodes.filter((node) => node.type === item[0]).length
  ]));
  if (listFilter !== 'all' && !counts.get(listFilter)) listFilter = 'all';
  for (const item of types) {
    const count = counts.get(item[0]);
    if (item[0] !== 'all' && count === 0) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.filter = item[0];
    button.textContent = item[1] + ' (' + count + ')';
    if (listFilter === item[0]) button.classList.add('active');
    if (item[0] !== 'all') button.classList.add(nodeTypeClass(item[0]));
    filters.appendChild(button);
  }
}

function updateListSelection() {
  const rows = byId('node-list').querySelectorAll('.node-row[data-node-id]');
  for (const row of rows) {
    row.classList.toggle('selected', row.dataset.nodeId === selectedNodeId);
  }
}

function renderList() {
  renderFilters();
  const query = byId('list-search').value.trim().toLowerCase();
  const sortMode = byId('list-sort').value;
  let nodes = allNodes.filter((node) => listFilter === 'all' || node.type === listFilter);
  if (query) {
    nodes = nodes.filter((node) =>
      nodeName(node).toLowerCase().includes(query) ||
      (node.keywords || []).some((keyword) => String(keyword).toLowerCase().includes(query)) ||
      (node.globalKeywords || []).some((keyword) => String(keyword).toLowerCase().includes(query)) ||
      String(node.content || '').toLowerCase().includes(query)
    );
  }
  nodes = nodes.slice();
  if (sortMode === 'importance') {
    nodes.sort((a, b) => (b.importance || 0) - (a.importance || 0) || (b.activationScore || 0) - (a.activationScore || 0));
  } else if (sortMode === 'time') {
    nodes.sort((a, b) => (a.creationTurn || 0) - (b.creationTurn || 0) || String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  } else {
    nodes.sort((a, b) => (b.activationScore || 0) - (a.activationScore || 0));
  }

  const list = byId('node-list');
  list.replaceChildren();
  if (!nodes.length) {
    addText(list, 'div', '조건에 맞는 노드가 없습니다.', 'empty-list');
    return;
  }
  for (const node of nodes) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'node-row list-row' + (selectedNodeId === node.id ? ' selected' : '');
    row.dataset.nodeId = node.id;
    const typeClass = nodeTypeClass(node.type);
    const dot = document.createElement('span');
    dot.className = 'node-dot ' + typeClass;
    row.appendChild(dot);
    const main = document.createElement('span');
    main.className = 'node-main';
    addText(main, 'span', (node.alwaysActive ? '📌 ' : '') + nodeName(node), 'node-name');
    addText(main, 'span', TYPE_NAMES[node.type] || node.type || '기타', 'node-type node-chip ' + typeClass);
    row.appendChild(main);
    addText(row, 'span', '⚡' + Math.round(node.activationScore || 0) + ' ★' + (node.importance || 0), 'node-score');
    list.appendChild(row);
  }
}

function setViewMode(mode) {
  viewMode = mode;
  const graphMode = mode === 'graph';
  byId('graph-view').hidden = !graphMode;
  byId('list-view').hidden = graphMode;
  byId('mode-graph').classList.toggle('active', graphMode);
  byId('mode-list').classList.toggle('active', !graphMode);
  if (graphMode && graphEngine) {
    requestAnimationFrame(() => {
      graphEngine._resize();
      graphEngine._render();
    });
  } else {
    renderList();
  }
}

function updateStats(visibleCount) {
  const count = visibleCount == null ? allNodes.length : visibleCount;
  const edgeCount = graphEngine ? graphEngine.edges.length : 0;
  byId('stats').textContent = count + '/' + allNodes.length + '개 노드 · ' + edgeCount + '개 엣지';
}

function applyGraphFilter() {
  if (!graphEngine) return;
  const query = byId('graph-search').value.trim().toLowerCase();
  const hops = Number.parseInt(byId('graph-hops').value || '0', 10);
  if (!query || hops === 0) {
    graphEngine.load(allNodes);
    graphEngine.alpha = 0.5;
    graphEngine.start();
    updateStats(allNodes.length);
    return;
  }
  const seeds = new Set();
  for (const node of allNodes) {
    if (nodeName(node).toLowerCase().includes(query) || (node.keywords || []).some((keyword) => String(keyword).toLowerCase().includes(query))) seeds.add(node.id);
  }
  if (!seeds.size) {
    setStatus('“' + query + '”에 맞는 노드가 없습니다.', 'err');
    return;
  }
  setStatus('');
  const visited = new Set(seeds);
  let frontier = Array.from(seeds);
  for (let hop = 0; hop < hops; hop++) {
    const next = [];
    for (const nodeId of frontier) {
      const node = nodeById.get(nodeId);
      if (node) {
        for (const rel of (node.relationships || [])) {
          if (nodeById.has(rel.targetId) && !visited.has(rel.targetId)) {
            visited.add(rel.targetId);
            next.push(rel.targetId);
          }
        }
      }
      for (const source of allNodes) {
        if ((source.relationships || []).some((rel) => rel.targetId === nodeId) && !visited.has(source.id)) {
          visited.add(source.id);
          next.push(source.id);
        }
      }
    }
    frontier = next;
  }
  graphEngine.loadSubgraph(allNodes, visited);
  graphEngine.start();
  window.setTimeout(() => {
    if (graphEngine) { graphEngine.fitView(); graphEngine._render(); }
  }, 800);
  updateStats(visited.size);
}

function initializeGraph() {
  if (graphEngine) graphEngine.destroy();
  const host = byId('graph');
  host.replaceChildren();
  graphEngine = new ForceGraphEngine(host);
  graphEngine.init();
  graphEngine.load(allNodes);
  graphEngine.onNodeClick = (nodeId) => {
    selectedNodeId = nodeId;
    if (nodeId) {
      renderDetail(nodeId);
    } else {
      resetDetail();
    }
    updateListSelection();
  };
  graphEngine.onNodeDoubleClick = (nodeId) => selectNode(nodeId, true);
  graphEngine.start();
  window.setTimeout(() => {
    if (graphEngine) { graphEngine.fitView(); graphEngine._render(); }
  }, 1200);
  updateStats(allNodes.length);
}

async function loadNodes(chatKey, incremental) {
  if (!chatKey) return;
  setStatus('노드를 불러오는 중…');
  try {
    const response = await fetch('/api/chats/' + encodeURIComponent(chatKey) + '/nodes', { headers: headers });
    if (response.status === 401) {
      setStatus('토큰이 올바르지 않습니다 — 설정 페이지에서 다시 입력하세요.', 'err');
      return;
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    const nextNodes = normalizeNodes(data.nodes);
    allNodes = nextNodes.filter((node, index, arr) => node && node.id && arr.findIndex((candidate) => candidate.id === node.id) === index);
    nodeById = new Map(allNodes.map((node) => [node.id, node]));
    if (selectedNodeId && !nodeById.has(selectedNodeId)) selectedNodeId = null;
    if (incremental && graphEngine && graphEngine.initialized) graphEngine.update(allNodes);
    else initializeGraph();
    renderList();
    if (selectedNodeId) renderDetail(selectedNodeId);
    else resetDetail();
    setStatus('턴 ' + data.turn + ' · 노드 ' + allNodes.length + '개', 'ok');
  } catch (error) {
    setStatus('노드 불러오기 실패: ' + error.message, 'err');
  }
}

async function loadChats() {
  if (!token) {
    setStatus('토큰이 없습니다 — 설정 페이지를 먼저 열어 토큰을 입력하세요.', 'err');
    byId('chat-select').innerHTML = '<option value="">토큰 필요</option>';
    return;
  }
  try {
    const response = await fetch('/api/chats', { headers: headers });
    if (response.status === 401) {
      setStatus('토큰이 올바르지 않습니다 — 설정 페이지에서 다시 입력하세요.', 'err');
      return;
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const chats = await response.json();
    const select = byId('chat-select');
    select.replaceChildren();
    if (!chats.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '채팅 없음';
      select.appendChild(option);
      setStatus('채팅이 없습니다 — 플러그인으로 채팅을 시작하면 여기에 나타납니다.');
      return;
    }
    for (const chat of chats) {
      const option = document.createElement('option');
      option.value = chat.chatKey;
      option.textContent = chat.chatKey + ' · 노드 ' + chat.nodeCount + '개 · 턴 ' + chat.currentTurn;
      select.appendChild(option);
    }
    const requested = new URLSearchParams(location.search).get('chatKey');
    const chosen = requested && chats.some((chat) => chat.chatKey === requested) ? requested : chats[0].chatKey;
    select.value = chosen;
    const url = new URL(location.href);
    url.searchParams.set('chatKey', chosen);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    await loadNodes(chosen, false);
  } catch (error) {
    setStatus('채팅 목록 불러오기 실패: ' + error.message, 'err');
  }
}

byId('chat-select').addEventListener('change', (event) => {
  const chatKey = event.target.value;
  if (!chatKey) return;
  const url = new URL(location.href);
  url.searchParams.set('chatKey', chatKey);
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  selectedNodeId = null;
  loadNodes(chatKey, false);
});
byId('reload').addEventListener('click', () => loadNodes(byId('chat-select').value, true));
byId('mode-graph').addEventListener('click', () => setViewMode('graph'));
byId('mode-list').addEventListener('click', () => setViewMode('list'));
byId('fit').addEventListener('click', () => {
  if (graphEngine) { graphEngine.fitView(); graphEngine._render(); }
});
byId('relayout').addEventListener('click', () => {
  if (!graphEngine) return;
  graphEngine.load(allNodes, true);
  graphEngine.start();
  window.setTimeout(() => {
    if (graphEngine) { graphEngine.fitView(); graphEngine._render(); }
  }, 1200);
});
byId('components').addEventListener('click', (event) => {
  if (!graphEngine) return;
  if (graphEngine.componentColors) {
    graphEngine.clearComponentColoring();
    event.currentTarget.classList.remove('active');
    event.currentTarget.textContent = '🧩 컴포넌트';
  } else {
    graphEngine.setComponentColoring();
    event.currentTarget.classList.add('active');
    event.currentTarget.textContent = '🧩 컴포넌트 (' + graphEngine._componentInfo.length + ')';
  }
});
byId('graph-search').addEventListener('input', () => {
  window.clearTimeout(graphFilterTimer);
  graphFilterTimer = window.setTimeout(applyGraphFilter, 400);
});
byId('graph-hops').addEventListener('change', applyGraphFilter);
byId('list-search').addEventListener('input', renderList);
byId('list-sort').addEventListener('change', renderList);
byId('filters').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  listFilter = button.dataset.filter;
  renderList();
});
byId('node-list').addEventListener('click', (event) => {
  const row = event.target.closest('[data-node-id]');
  if (row) selectNode(row.dataset.nodeId, false);
});
byId('detail').addEventListener('click', async (event) => {
  const actionButton = event.target.closest('[data-detail-action]');
  if (actionButton) {
    const action = actionButton.dataset.detailAction;
    const nodeId = actionButton.dataset.nodeId || selectedNodeId;
    if (action === 'edit' && nodeId) {
      renderEditForm(nodeId);
    } else if (action === 'cancel-edit' && selectedNodeId) {
      renderDetail(selectedNodeId);
    } else if (action === 'toggle-pin' && nodeId) {
      const node = nodeById.get(nodeId);
      if (!node) return;
      actionButton.disabled = true;
      try {
        const updated = await patchNode(nodeId, { alwaysActive: !node.alwaysActive });
        applyUpdatedNode(updated);
        renderDetail(nodeId);
        setStatus(nodeName(updated) + (updated.alwaysActive ? ' 노드를 항상 활성으로 고정했습니다.' : ' 노드의 핀을 해제했습니다.'), 'ok');
      } catch (error) {
        actionButton.disabled = false;
        setStatus('핀 변경 실패: ' + error.message, 'err');
      }
    } else if (action === 'delete' && nodeId) {
      const node = nodeById.get(nodeId);
      if (!node) return;
      if (!confirm('이 노드를 삭제합니다. 관계도 함께 정리되며, 직전 상태는 스냅샷으로 남습니다. 계속할까요?')) return;
      const removedName = nodeName(node);
      actionButton.disabled = true;
      try {
        await deleteNode(nodeId);
        allNodes = allNodes.filter((candidate) => candidate.id !== nodeId);
        nodeById.delete(nodeId);
        selectedNodeId = null;
        if (graphEngine && graphEngine.initialized) graphEngine.update(allNodes);
        renderList();
        resetDetail();
        updateStats(allNodes.length);
        setStatus(removedName + ' 노드를 삭제했습니다', 'ok');
      } catch (error) {
        actionButton.disabled = false;
        setStatus('노드 삭제 실패: ' + error.message, 'err');
      }
    }
    return;
  }
  const link = event.target.closest('[data-node-id]');
  if (link) selectNode(link.dataset.nodeId, viewMode === 'graph');
});
byId('detail').addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-node-edit-form]');
  if (!form) return;
  event.preventDefault();
  const nodeId = form.dataset.editNodeId;
  const field = (name) => form.elements.namedItem(name);
  const save = form.querySelector('button[type="submit"]');
  if (save) save.disabled = true;
  const patch = {
    name: field('name').value.trim(),
    content: field('content').value,
    keywords: splitKeywords(field('keywords').value),
    globalKeywords: splitKeywords(field('globalKeywords').value),
    importance: Number(field('importance').value),
    archived: !!field('archived').checked,
    excluded: !!field('excluded').checked
  };
  const activation = field('activationScore');
  if (activation) patch.activationScore = Number(activation.value); // lore는 칸이 없음 (서버가 무시하는 필드)
  const timestamp = field('timestamp');
  if (timestamp) patch.timestamp = timestamp.value.trim() || null;
  try {
    const updated = await patchNode(nodeId, patch);
    applyUpdatedNode(updated);
    renderDetail(nodeId);
    setStatus(nodeName(updated) + ' 노드를 저장했습니다.', 'ok');
  } catch (error) {
    if (save) save.disabled = false;
    setStatus('노드 저장 실패: ' + error.message, 'err');
  }
});

loadChats();
</script>
</body>
</html>`;
