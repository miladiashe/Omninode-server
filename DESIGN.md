# OmniNode 디자인 시스템 (v1)

> 이 문서는 웹 4페이지 + 플러그인 다이얼로그 전체 테마 공사의 **단일 진실 원장**이다.
> 구현자(codex)는 이 문서에 없는 색·크기·효과를 임의로 만들 수 없다. 애매하면 멈추고 물어볼 것.

---

## 1. 브랜드 컨셉

**"기억의 그물 (Web of Memories)"** — 로고/심볼은 🕸️.

- 어두운 밤하늘(다크) 또는 밝은 종이(라이트) 위에, 파스텔 노드들이 그물로 이어진 이미지.
- 그래프 뷰어가 제품의 얼굴이며, 그래프의 노드 색이 곧 브랜드 색이다.
- 팔레트는 **Catppuccin** (https://catppuccin.com, MIT) 을 공식 채택:
  - 다크 = **Mocha**, 라이트 = **Latte**. 두 팔레트는 색 이름이 1:1 대응된다.
  - 원작 그래프 뷰어의 노드/엣지 색이 이미 Catppuccin Mocha 표준값이라, 이 채택으로 그래프와 나머지 UI가 자동으로 한 세계가 된다.
- 브랜드 프라이머리 = 보라 계열: **Mocha에서 Lavender, Latte에서 Mauve**. (보라 = 그물/밤. Latte lavender `#7287fd`는 밝은 배경 대비 2.8:1로 텍스트·버튼에 부적합해 mauve `#8839ef`(≈4.8:1)를 쓴다. Mocha에서 mauve를 피하는 이유는 Community 노드 색 충돌 — Latte에서는 칩이 틴트+테두리 형태라 충돌을 수용한다.)

**톤앤매너**: 차분하고 밀도 있는 도구. 장식보다 정보. 애니메이션은 그래프 물리 시뮬 하나로 충분하므로 UI 쪽 모션은 최소(호버 전환 0.15s 수준만).

---

## 2. 철칙 (구현자 필독)

1. **토큰 밖 색 금지.** 모든 색은 §3의 CSS 변수로만 참조한다. hex 하드코딩 금지 (캔버스 포함 — §8 참조).
2. **마크업·IA 불변.** `nav.topnav` + `span.current[aria-current="page"]` 구조, 페이지 구성, 버튼·링크의 위치와 동작은 확정된 IA다. 클래스 추가는 허용, 구조 변경·요소 삭제는 금지.
3. **문구 변경 금지.** 텍스트/카피는 별도 작업(비공개 카피 노트에서 확정 후 일괄 반영)이다. 디자인 공사에서 문구를 건드리지 않는다.
4. **양 테마 동시 완성.** 모든 컴포넌트는 Mocha/Latte 두 테마에서 검증한다. 한쪽만 보고 커밋 금지.
5. **대비 기준**: 본문 텍스트 ≥ 4.5:1, 큰 제목·보조 텍스트 ≥ 3:1 (WCAG AA). Catppuccin 표준 조합(base 위 text, accent 위 base/crust)을 지키면 자동 충족된다.
6. **단일 소스.** 토큰과 공용 컴포넌트 CSS는 `src/web/theme.ts` 한 곳에서 export하고 4페이지가 공유한다 (§11).

---

## 3. 팔레트 & 시맨틱 토큰

### 3.1 원색 (Catppuccin 표준값 — 수정 금지)

| 이름 | Mocha (다크) | Latte (라이트) |
|---|---|---|
| rosewater | `#f5e0dc` | `#dc8a78` |
| flamingo | `#f2cdcd` | `#dd7878` |
| pink | `#f5c2e7` | `#ea76cb` |
| mauve | `#cba6f7` | `#8839ef` |
| red | `#f38ba8` | `#d20f39` |
| maroon | `#eba0ac` | `#e64553` |
| peach | `#fab387` | `#fe640b` |
| yellow | `#f9e2af` | `#df8e1d` |
| green | `#a6e3a1` | `#40a02b` |
| teal | `#94e2d5` | `#179299` |
| sky | `#89dceb` | `#04a5e5` |
| sapphire | `#74c7ec` | `#209fb5` |
| blue | `#89b4fa` | `#1e66f5` |
| lavender | `#b4befe` | `#7287fd` |
| text | `#cdd6f4` | `#4c4f69` |
| subtext1 | `#bac2de` | `#5c5f77` |
| subtext0 | `#a6adc8` | `#6c6f85` |
| overlay2 | `#9399b2` | `#7c7f93` |
| overlay1 | `#7f849c` | `#8c8fa1` |
| overlay0 | `#6c7086` | `#9ca0b0` |
| surface2 | `#585b70` | `#acb0be` |
| surface1 | `#45475a` | `#bcc0cc` |
| surface0 | `#313244` | `#ccd0da` |
| base | `#1e1e2e` | `#eff1f5` |
| mantle | `#181825` | `#e6e9ef` |
| crust | `#11111b` | `#dce0e8` |

### 3.2 시맨틱 토큰 (CSS 변수 — 코드에서는 이것만 사용)

| 토큰 | 값 | 용도 |
|---|---|---|
| `--bg` | base | 페이지 배경 |
| `--bg-deep` | mantle | 사이드 영역·움푹한 배경 (그래프 프레임 배경, 코드블록) |
| `--bg-deepest` | crust | 캔버스 뒤 최심부, 모달 뒷배경 딤의 바탕색 |
| `--surface` | surface0 | 카드·패널·입력창 배경 |
| `--surface-hi` | surface1 | 호버·선택된 행, 상승한 표면 |
| `--border` | surface1 | 기본 테두리 |
| `--border-strong` | overlay0 | 강조 테두리 (포커스 아님) |
| `--text` | text | 본문 |
| `--text-dim` | subtext1 | 보조 텍스트 |
| `--text-faint` | subtext0 | 힌트·라벨·비활성 |
| `--accent` | Mocha: lavender / Latte: **mauve** (§1 대비 사유) | 브랜드 프라이머리: 주요 버튼, 활성 탭, 링크, 포커스 링 |
| `--accent-contrast` | Mocha: crust / Latte: base | accent 배경 위 글자색 |
| `--ok` | green | 성공 상태 |
| `--warn` | yellow | 경고 상태 |
| `--err` | red | 오류·위험 버튼 |
| `--node-lore` | blue | Lore 노드 |
| `--node-extra` | green | Entity(extraLore) 노드 |
| `--node-ltm` | peach | Memory(LTM) 노드 |
| `--node-lines` | yellow | Lines(대화 흔적·범례용) |
| `--node-comm` | mauve | Community 노드 |
| `--edge-causes` | red | 엣지: causes |
| `--edge-enables` | green | 엣지: enables |
| `--edge-prevents` | yellow | 엣지: prevents |
| `--edge-contradicts` | mauve | 엣지: contradicts |
| `--edge-develops` | blue | 엣지: develops |
| `--edge-related` | Mocha: `#cdd6f4` / Latte: `#4c4f69` (text) | 엣지: related (알파는 코드에서) |
| `--edge-parent` | peach | 엣지: parent |
| `--palette-<이름>` | Catppuccin accent 14색 (rosewater~lavender, 테마별 자동) | 그래프 컴포넌트 색칠 전용 (§8.1) — 일반 UI에서 직접 사용 금지 |

투명도가 필요한 곳(엣지 기본 0.5/호버 0.8, 배경 틴트 등)은 토큰을 `color-mix(in srgb, var(--edge-causes) 50%, transparent)` 로 파생시킨다. 알파값을 바꿔야 하면 문서를 먼저 고친다.

### 3.3 상태·포커스

- 포커스 링: `outline: 2px solid var(--accent); outline-offset: 2px` — 모든 인터랙티브 요소 공통. `:focus-visible`에만.
- 비활성(disabled): `opacity: .5; cursor: not-allowed`. 색을 따로 만들지 않는다.

---

## 4. 테마 메커니즘

- `<html data-theme="mocha|latte">`. 초기값: `localStorage['omninode-theme']` → 없으면 `prefers-color-scheme` (dark→mocha, light→latte).
- 토큰 정의: `:root`(= mocha 기본) + `[data-theme="latte"]` 오버라이드. `color-scheme: dark` / `light` 도 각각 선언 (네이티브 폼 위젯·스크롤바 일치).
- **토글**: topnav 우측 끝에 아이콘 버튼 1개 (🌙/☀️). 클릭 시 data-theme 전환 + localStorage 저장. 4페이지 공통 (theme.ts의 공용 스크립트).
- **캔버스 연동**: 그래프 엔진은 색을 하드코딩하지 않고 `getComputedStyle(document.documentElement)`에서 토큰을 읽어 내부 팔레트 객체를 구성한다. data-theme 변경 시(MutationObserver 또는 토글 콜백) 팔레트 재구성 + 강제 redraw 1회.

---

## 5. 타이포그래피

- 폰트 스택 (웹폰트 없음 — 서버 셀프호스팅 제품이므로 외부 요청 금지):
  `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;`
  코드·수치: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`.
- 크기 위계 (rem):

| 역할 | 크기 | 굵기 | 행간 |
|---|---|---|---|
| 페이지 제목 (h1) | 1.35rem | 700 | 1.3 |
| 섹션 제목 (h2) | 1.05rem | 700 | 1.35 |
| 본문 | 0.92rem | 400 | 1.55 |
| 보조·라벨 | 0.8rem | 500 | 1.45 |
| 힌트·캡션 | 0.74rem | 400 | 1.4 |

- 숫자 나열(토큰 수, 노드 수 등)은 `font-variant-numeric: tabular-nums`.

---

## 6. 간격 · 라운딩 · 그림자

- 간격 스케일: **4px 배수만** — 4 / 8 / 12 / 16 / 20 / 24 / 32. 임의 수치(예: 9px, 7px) 사용 금지, 기존 임의 수치는 가장 가까운 스케일로 교정.
- 라운딩: 입력·버튼 **8px**, 카드·패널 **12px**, 모달 **16px**, 칩·배지 **999px**.
- 그림자: 다크 테마에서는 그림자 대신 **표면 밝기 차 + 테두리**로 층위 표현 (Catppuccin 관례). 라이트 테마 모달에만 `0 8px 24px rgba(76,79,105,.15)` 허용. 그 외 그림자 금지.

---

## 7. 컴포넌트 규격

공통: 인터랙티브 요소 최소 높이 36px (모바일 터치 44px — 플러그인 다이얼로그는 44px 유지).

- **버튼(기본)**: `background: var(--surface); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 8px 14px;` hover → `background: var(--surface-hi)`.
- **버튼(프라이머리)**: `background: var(--accent); color: var(--accent-contrast); border: 0;` hover → `filter: brightness(1.08)`. 페이지당 1~2개만 (가장 중요한 액션).
- **버튼(위험)**: 기본 버튼 형태에 `border-color: var(--err); color: var(--err)`. 채우지 않는다 (실수 클릭 방지).
- **카드/패널**: `background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px`.
- **탭** (설정 페이지): 활성 = `background: var(--accent); color: var(--accent-contrast)`; 비활성 = 기본 버튼과 동일.
- **topnav**: `background: var(--bg-deep); border-bottom: 1px solid var(--border)`. 링크 = `--text-dim`, hover = `--text`, 현재 페이지(`span.current`) = `color: var(--accent); font-weight: 700` + 하단 2px accent 보더. 우측 끝 테마 토글.
- **입력창**: `background: var(--bg-deep); border: 1px solid var(--border); border-radius: 8px; color: var(--text);` focus → §3.3 포커스 링.
- **배지/칩**: `border-radius: 999px; font-size: .74rem; padding: 2px 10px`. 타입 칩은 해당 `--node-*` 색 테두리 + 같은 색 12% 틴트 배경 (`color-mix ... 12%, transparent`).
- **상태 텍스트**: `.ok` → `--ok`, `.err` → `--err`, 경고 → `--warn`.
- **테이블/목록 행**: 사선 없음, 행 구분 `1px solid var(--border)`, hover/선택 = `--surface-hi`.
- **콜랩스 섹션** (주입 뷰어의 낙선 후보 등): summary 행은 목록 행 규격, 펼침 내용은 `--bg-deep` 배경.

---

## 8. 그래프 캔버스 토큰화

### 8.1 교체표 (MD3 잔재 청산)

| 현재 하드코딩 | 교체 |
|---|---|
| `#1D1B20` (캔버스 배경) | `--bg-deep` |
| `#E6E0E9` (강조 글자) | `--text` |
| `#D0BCFF` / `--md-sys-color-primary` 폴백 | `--accent` |
| `#a6adc8` (보조 글자·기본 노드색) | `--text-faint` |
| NODE_TYPE_COLORS 5색 | `--node-*` 5종 |
| EDGE_COLORS / EDGE_COLORS_HOVER | `--edge-*` × 알파 0.5 / 0.8 (related는 0.15 / 0.6) |
| 범례·라벨 배경 `#1D1B20` | `--bg-deep` |
| 컴포넌트 팔레트 15색 (`#EFB8C8`…) | `--palette-*` 14색 + `--accent` (테마별 자동): accent, pink, sapphire, green, yellow, peach, red, teal, mauve, blue, lavender, flamingo, sky, maroon, rosewater |

### 8.2 오버레이 (테마별 수치가 다른 유일한 구역)

노드 채움·글로우·딤은 다크 전제로 튜닝돼 있으므로 **토큰이 아니라 테마별 상수 세트**로 분리한다 (`GRAPH_OVERLAY[theme]`):

| 항목 | Mocha (현행 유지) | Latte 초기값 (QA로 보정) |
|---|---|---|
| 노드 채움 기본 | `rgba(30,30,50,0.6)` | `rgba(255,255,255,0.75)` |
| 노드 채움 hover | `rgba(40,40,65,0.7)` | `rgba(255,255,255,0.88)` |
| 노드 채움 선택 | `rgba(50,50,80,0.8)` | `rgba(220,224,232,0.95)` |
| 2-hop 딤 알파 테이블 | 현행 | 현행 × 시각 확인 후 보정 |
| 활성화 글로우 | 현행 | 블러 반경 동일, 알파 0.7배에서 시작 |

Latte 수치는 초기 제안값이며, 구현 후 실그래프에서 스크린샷 비교로 확정한다. **Mocha 쪽 수치는 절대 변경 금지** (이미 실사용 검증됨).

### 8.3 물리·레이아웃 불변

k/springLen/springK/gravityK, 틱 로직, 컬링, fitView 등 **엔진 동작 코드는 이번 공사에서 1글자도 건드리지 않는다.** 색 참조 방식만 바꾼다.

---

## 9. 페이지별 노트

공통: 본문 최대 폭 960px 중앙 정렬 (그래프 페이지 제외 — 그래프는 전폭), 페이지 패딩 16px(모바일)/24px.

- **설정**: 탭 §7 규격. 연결 탭의 플러그인 다운로드 폴백 문구는 힌트 스타일(`--text-faint`).
- **대시보드**: 통계 숫자는 카드 + tabular-nums + `--accent` 강조. 위험 버튼(리셋 등)은 §7 위험 규격.
- **그래프**: 프레임 배경 `--bg-deep`, 프레임 테두리 `--border`. 목록 뷰 행·타입 칩·상세 패널은 §7 규격. 상세 패널의 본문 프리뷰는 `--bg-deep` 배경.
- **주입 뷰어**: 채택 후보는 기본 행, 낙선 후보 콜랩스는 §7 콜랩스 규격. 점수 수치는 모노스페이스 + tabular-nums.

---

## 10. 플러그인 다이얼로그 (settings-dialog / start-dialog / lorebook-selector)

- RisuAI 내부 오버레이이므로 **Mocha 고정** (테마 토글 없음). 전체 화면 딤(`rgba(17,17,27,.92)` = crust 92%) 위에 뜨는 구조라 호스트 테마와 충돌하지 않는다.
- 현재 Tailwind 바이올렛 계열을 Catppuccin으로 치환:

| 현재 | 교체 (Mocha) |
|---|---|
| `#8b5cf6` (프라이머리 버튼) | lavender `#b4befe` + 글자 crust `#11111b` |
| `#171326` (모달 배경) | base `#1e1e2e` |
| `#211c33` / `#29243a` (입력·보조 버튼) | surface0 `#313244` |
| `#4c4564` / `#403858` (테두리) | surface1 `#45475a` |
| `#f3f0ff` / `#f5f3ff` (본문) | text `#cdd6f4` |
| `#ddd6fe` / `#aaa2c2` (보조) | subtext1 `#bac2de` / subtext0 `#a6adc8` |
| `#c4b5fd` / `#a78bfa` (안내·링크) | lavender `#b4befe` |
| `#fbbf24` (경고 피드백) | yellow `#f9e2af` |
| `#86efac` (성공 피드백) | green `#a6e3a1` |
| `rgba(139,92,246,.3)` 그림자 | 제거 (§6 — 다크는 그림자 금지) |
| `rgba(8,6,18,.96)` 딤 | `rgba(17,17,27,.92)` |

- 플러그인은 CSS 변수 시트를 주입할 호스트가 없으므로 **상수 모듈**(`plugin/src/theme.ts`)로 정의하고 세 다이얼로그가 공유한다. 값은 §3.1 Mocha 표와 동일해야 하며, 서버 웹 쪽 theme.ts와 값이 어긋나면 안 된다 (리뷰 시 대조).
- **웹과 같은 컨셉이어야 한다 — 색뿐 아니라 모양 문법까지.** 라운딩은 §6 스케일로 통일 (입력·버튼 8px, 카드성 블록 12px, 모달 16px — 현행 20px/12px 임의값 교정), 버튼·입력·배지·상태색은 §7 규격을 따른다. 타이포 크기 위계도 §5에 맞춘다.
- 모바일 예외 딱 하나: 인터랙티브 요소 최소 높이 **44px 유지** (웹의 36px보다 크게 — 터치 환경 검증 완료된 값). 레이아웃 구조(요소 배치·플로우)는 현행 유지.

---

## 11. 구현 아키텍처

- 신규 `src/web/theme.ts`:
  - `export const THEME_CSS` — §3 토큰 정의(`:root` + `[data-theme="latte"]`) + §5~7 공용 컴포넌트 클래스.
  - `export const THEME_SCRIPT` — 초기 테마 결정 + 토글 핸들러. `<head>`에서 charset·viewport 메타 **바로 뒤**에 인라인 (charset은 문서 첫 1024바이트 안에 있어야 하므로 스크립트보다 앞; 스타일 적용 전이라 FOUC 없음).
  - 4페이지는 각자의 `<style>`에서 공용 부분을 제거하고 THEME_CSS를 주입, 페이지 고유 스타일만 남긴다.
- `plugin/src/theme.ts`: Mocha 상수 객체 (§10).
- 그래프 엔진: `resolvePalette()` 함수가 토큰 → 내부 팔레트 객체 변환 (§4, §8).

---

## 12. QA 체크리스트 (완료 조건)

- [ ] 4페이지 × 2테마 = 8화면 스크린샷, 토큰 외 색 없음 (grep으로 hex 하드코딩 검사 — 허용 목록: theme.ts 두 개, GRAPH_OVERLAY)
- [ ] 테마 토글: 새로고침 없이 즉시 전환, 그래프 캔버스 포함, localStorage 유지, FOUC 없음
- [ ] 시스템 다크/라이트 자동 감지 (localStorage 비운 상태)
- [ ] 그래프 Mocha 렌더: 노드·엣지·오버레이·딤/글로우·물리는 공사 전과 픽셀 수준 동일. 의도된 변경 3+1건만 예외 — MD3 잔재 교체(#1D1B20→base 계열, #E6E0E9→text, #D0BCFF→accent)와 컴포넌트 팔레트 재정의
- [ ] 그래프 Latte: 노드 라벨 가독, 딤/글로우 시각 확인
- [ ] 플러그인 3다이얼로그 모바일 확인 (터치 타깃 44px 유지)
- [ ] `npm test` 전체 통과 + tsc 양쪽 (server/plugin)
- [ ] 대비 스팟체크: 본문 4.5:1. **Latte yellow(#df8e1d)는 밝은 배경 대비 2.3:1 — 텍스트 단독 사용 금지, 칩/배지(틴트 배경+테두리) 형태만 허용.** (현재 웹에 `.warn` 텍스트 단독 사용처 없음 — 새로 만들지 말 것)

## 13. 작업 분할 (발주 단위)

1. **T1**: `src/web/theme.ts` 신설 (토큰+공용 CSS+토글 스크립트) + 설정/대시보드/주입 3페이지 적용
2. **T2**: 그래프 페이지 — 페이지 CSS 적용 + 캔버스 토큰화(§8) + GRAPH_OVERLAY 분리
3. **T3**: 플러그인 `theme.ts` + 3다이얼로그 치환 (§10)
4. **T4**: QA 패스 (§12) + Latte 오버레이 보정

각 단계 후 tsc/test 통과 확인, 단계별 커밋.
