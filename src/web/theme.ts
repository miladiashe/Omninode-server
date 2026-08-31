// OmniNode server web theme — DESIGN.md is the source of truth.
// Hex literals intentionally live only in this shared token sheet.
export const THEME_CSS = `
:root {
  color-scheme: dark;
  --bg: #1e1e2e;
  --bg-deep: #181825;
  --bg-deepest: #11111b;
  --surface: #313244;
  --surface-hi: #45475a;
  --border: #45475a;
  --border-strong: #6c7086;
  --text: #cdd6f4;
  --text-dim: #bac2de;
  --text-faint: #a6adc8;
  --accent: #b4befe;
  --accent-contrast: #11111b;
  --ok: #a6e3a1;
  --warn: #f9e2af;
  --err: #f38ba8;
  --node-lore: #89b4fa;
  --node-extra: #a6e3a1;
  --node-ltm: #fab387;
  --node-lines: #f9e2af;
  --node-comm: #cba6f7;
  --edge-causes: #f38ba8;
  --edge-enables: #a6e3a1;
  --edge-prevents: #f9e2af;
  --edge-contradicts: #cba6f7;
  --edge-develops: #89b4fa;
  --edge-related: #cdd6f4;
  --edge-parent: #fab387;
  /* 그래프 컴포넌트 색칠 전용 팔레트 (DESIGN.md §3.2/§8.1) — 일반 UI에서 직접 사용 금지 */
  --palette-rosewater: #f5e0dc;
  --palette-flamingo: #f2cdcd;
  --palette-pink: #f5c2e7;
  --palette-mauve: #cba6f7;
  --palette-red: #f38ba8;
  --palette-maroon: #eba0ac;
  --palette-peach: #fab387;
  --palette-yellow: #f9e2af;
  --palette-green: #a6e3a1;
  --palette-teal: #94e2d5;
  --palette-sky: #89dceb;
  --palette-sapphire: #74c7ec;
  --palette-blue: #89b4fa;
  --palette-lavender: #b4befe;
}

[data-theme="latte"] {
  color-scheme: light;
  --bg: #eff1f5;
  --bg-deep: #e6e9ef;
  --bg-deepest: #dce0e8;
  --surface: #ccd0da;
  --surface-hi: #bcc0cc;
  --border: #bcc0cc;
  --border-strong: #9ca0b0;
  --text: #4c4f69;
  --text-dim: #5c5f77;
  --text-faint: #6c6f85;
  /* Latte accent는 mauve — lavender는 밝은 배경 대비 2.8:1로 텍스트 부적합 (DESIGN.md §3.2) */
  --accent: #8839ef;
  --accent-contrast: #eff1f5;
  --ok: #40a02b;
  --warn: #df8e1d;
  --err: #d20f39;
  --node-lore: #1e66f5;
  --node-extra: #40a02b;
  --node-ltm: #fe640b;
  --node-lines: #df8e1d;
  --node-comm: #8839ef;
  --edge-causes: #d20f39;
  --edge-enables: #40a02b;
  --edge-prevents: #df8e1d;
  --edge-contradicts: #8839ef;
  --edge-develops: #1e66f5;
  --edge-related: #4c4f69;
  --edge-parent: #fe640b;
  /* 그래프 컴포넌트 색칠 전용 팔레트 (DESIGN.md §3.2/§8.1) — 일반 UI에서 직접 사용 금지 */
  --palette-rosewater: #dc8a78;
  --palette-flamingo: #dd7878;
  --palette-pink: #ea76cb;
  --palette-mauve: #8839ef;
  --palette-red: #d20f39;
  --palette-maroon: #e64553;
  --palette-peach: #fe640b;
  --palette-yellow: #df8e1d;
  --palette-green: #40a02b;
  --palette-teal: #179299;
  --palette-sky: #04a5e5;
  --palette-sapphire: #209fb5;
  --palette-blue: #1e66f5;
  --palette-lavender: #7287fd;
}

* {
  box-sizing: border-box;
}

html {
  background: var(--bg);
  color: var(--text);
}

body,
.body-text {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
  font-size: 0.92rem;
  font-weight: 400;
  line-height: 1.55;
}

body {
  max-width: 960px;
  margin: 0 auto;
  padding: 16px;
  background: var(--bg);
  color: var(--text);
}

@media (min-width: 60rem) {
  body {
    padding: 24px;
  }
}

h1,
.page-title {
  font-size: 1.35rem;
  font-weight: 700;
  line-height: 1.3;
}

h2,
.section-title {
  font-size: 1.05rem;
  font-weight: 700;
  line-height: 1.35;
}

h3 {
  font-size: 0.92rem;
  font-weight: 700;
  line-height: 1.55;
}

label,
.label-text,
.meta {
  font-size: 0.8rem;
  font-weight: 500;
  line-height: 1.45;
  color: var(--text-dim);
}

.hint,
.hint-text,
.caption {
  font-size: 0.74rem;
  font-weight: 400;
  line-height: 1.4;
  color: var(--text-faint);
}

code,
pre,
textarea,
.mono {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}

.numeric,
.meta,
.badge,
.chip,
.pill,
input[type="number"] {
  font-variant-numeric: tabular-nums;
}

a {
  color: var(--accent);
  text-decoration: none;
}

button,
.button {
  min-height: 36px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 500;
  line-height: 1.45;
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s, color 0.15s, filter 0.15s;
}

button:hover,
.button:hover {
  background: var(--surface-hi);
}

button.primary,
.button.primary {
  border: 0;
  background: var(--accent);
  color: var(--accent-contrast);
}

button.primary:hover,
.button.primary:hover {
  background: var(--accent);
  filter: brightness(1.08);
}

button.danger,
.button.danger {
  border-color: var(--err);
  background: var(--surface);
  color: var(--err);
}

button.danger:hover,
.button.danger:hover {
  background: var(--surface-hi);
}

.card,
.panel {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}

.tab {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}

.tab:hover {
  background: var(--surface-hi);
}

.tab.active {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}

.topnav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-deep);
  font-size: 0.8rem;
  font-weight: 500;
  line-height: 1.45;
}

.topnav a,
.topnav span.current {
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  padding: 0 4px;
}

.topnav a {
  color: var(--text-dim);
}

.topnav a:hover {
  color: var(--text);
}

.topnav span.current {
  border-bottom: 2px solid var(--accent);
  color: var(--accent);
  font-weight: 700;
}

.topnav .theme-toggle {
  width: 36px;
  min-width: 36px;
  margin-left: auto;
  padding: 4px 8px;
  flex: 0 0 auto;
}

input[type="text"],
input[type="password"],
input[type="number"],
textarea,
select {
  min-height: 36px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-deep);
  color: var(--text);
  font: inherit;
}

textarea {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}

input::placeholder,
textarea::placeholder {
  color: var(--text-faint);
  opacity: 1;
}

input[type="checkbox"] {
  accent-color: var(--accent);
}

.badge,
.chip,
.pill,
.node-chip {
  display: inline-block;
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 400;
  line-height: 1.4;
}

.accent-chip {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}

.node-chip.node-lore {
  border-color: var(--node-lore);
  background: color-mix(in srgb, var(--node-lore) 12%, transparent);
  color: var(--node-lore);
}

.node-chip.node-extra {
  border-color: var(--node-extra);
  background: color-mix(in srgb, var(--node-extra) 12%, transparent);
  color: var(--node-extra);
}

.node-chip.node-ltm {
  border-color: var(--node-ltm);
  background: color-mix(in srgb, var(--node-ltm) 12%, transparent);
  color: var(--node-ltm);
}

.node-chip.node-lines {
  border-color: var(--node-lines);
  background: color-mix(in srgb, var(--node-lines) 12%, transparent);
  color: var(--node-lines);
}

.node-chip.node-comm {
  border-color: var(--node-comm);
  background: color-mix(in srgb, var(--node-comm) 12%, transparent);
  color: var(--node-comm);
}

.ok {
  color: var(--ok);
}

.err {
  color: var(--err);
}

.warn {
  color: var(--warn);
}

.list-row,
.table-row {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  transition: background-color 0.15s;
}

.list-row:hover,
.list-row.selected,
.table-row:hover,
.table-row.selected,
tbody tr:hover,
tbody tr.selected {
  background: var(--surface-hi);
}

th,
td {
  padding: 12px;
  border-bottom: 1px solid var(--border);
}

details.collapsible {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}

details.collapsible > summary {
  min-height: 36px;
  padding: 12px 16px;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 700;
  line-height: 1.45;
}

details.collapsible[open] > summary {
  border-bottom: 1px solid var(--border);
}

details.collapsible[open] > :not(summary) {
  background: var(--bg-deep);
}

details.collapsible > .list-row:last-child {
  border-bottom: 0;
}

a:focus-visible,
button:focus-visible,
input:focus-visible,
textarea:focus-visible,
select:focus-visible,
summary:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

button:disabled,
input:disabled,
textarea:disabled,
select:disabled,
[aria-disabled="true"] {
  opacity: 0.5;
  cursor: not-allowed;
}
`;

export const THEME_SCRIPT = `
(function () {
  const storageKey = 'omninode-theme';
  const root = document.documentElement;

  function storedTheme() {
    try {
      const value = localStorage.getItem(storageKey);
      return value === 'mocha' || value === 'latte' ? value : null;
    } catch {
      return null;
    }
  }

  function syncToggle() {
    const icon = root.dataset.theme === 'latte' ? '🌙' : '☀️';
    document.querySelectorAll('.theme-toggle').forEach((button) => {
      button.textContent = icon;
    });
  }

  const initialTheme = storedTheme()
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'mocha' : 'latte');
  root.dataset.theme = initialTheme;

  window.toggleOmniNodeTheme = function () {
    const nextTheme = root.dataset.theme === 'latte' ? 'mocha' : 'latte';
    root.dataset.theme = nextTheme;
    try {
      localStorage.setItem(storageKey, nextTheme);
    } catch {
      // The selected theme still applies for this page when storage is unavailable.
    }
    syncToggle();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncToggle, { once: true });
  } else {
    syncToggle();
  }
})();
`;
