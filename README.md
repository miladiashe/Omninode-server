# OmniNode Server

RisuAI를 위한 **그래프 기억 서버**입니다. 대화가 쌓일수록 캐릭터·사건·장소를 기억 노드로 만들고 관계로 엮어, 다음 대화에 필요한 기억만 골라 프롬프트에 넣어줍니다. 채팅이 쉬는 동안엔 뒤에서 기억을 정리합니다(관련 기억 묶기, 끊긴 연결 잇기, 화면 밖 세계 진행, 정정 메모 압축).

RisuAI 플러그인 [OmniNode](https://arca.live/b/characterai/167365522)의 기억 기능을 별도 서버로 옮긴 것입니다. 원작자의 허락을 받아 만들었습니다.

**구성**: 이 서버 + RisuAI에 설치하는 커넥터 플러그인(별도 배포). 서버는 집 PC·맥미니·오라클 클라우드·안드로이드 폰(Termux) 어디든 Node.js가 돌면 됩니다.

---

## 설치 (4단계)

### 1. 서버 띄우기

**직접 실행** — Node.js 20 이상 필요

```bash
git clone https://github.com/miladiashe/Omninode-server omninode-server
cd omninode-server
npm install
npm run build
npm start
```

**도커**

```bash
git clone https://github.com/miladiashe/Omninode-server omninode-server
cd omninode-server
docker compose up -d
```

처음 켜면 터미널에 이런 배너가 뜹니다:

```
┌────────────────────────────────────────────────────────┐
│ OmniNode Server v0.1.0 (api v1)                        │
│ ⚠️  LLM 미설정 — 아래 주소에서 설정하세요!               │
│ 설정 페이지 (토큰 자동 입력됨):                          │
│   http://192.168.x.x:8756/settings#token=...           │
└────────────────────────────────────────────────────────┘
폰에서 설정하려면 QR 스캔: (QR 코드)
```

인증 토큰이 자동으로 만들어져 `data/auth-token`에 저장됩니다. 배너의 링크(또는 QR)로 설정 페이지를 열면 토큰이 자동 입력돼 있습니다.

### 2. LLM 연결하기

설정 페이지 → **연결** 탭에서 기억을 만들 LLM의 **API 형식**을 고르고 주소·키·모델을 넣고 저장합니다. 지원 형식: OpenAI 호환(chat/completions), OpenAI Responses, Claude(Anthropic), Claude(AWS Bedrock), Google AI Studio(Gemini), Google Vertex AI. "자동"은 주소로 판별하지만 Claude·Responses·Bedrock은 직접 골라야 합니다.

- **AWS Bedrock**: 리전과 Bedrock API 키(AWS 콘솔 → Bedrock → API keys)를 넣습니다. Opus 4.6 이하 모델(AWS 무료 크레딧으로 쓸 수 있는 세대)은 "구형" 엔드포인트, Opus 4.7 이후는 "신형"을 고르세요. 모델 ID는 구형이 `us.anthropic.claude-…-v1:0`, 신형이 `anthropic.claude-…` 형태입니다.
- **Vertex AI**: 서비스 계정 JSON 키 전체를 붙여넣습니다.

- **보조 LLM**: 요약·키워드 같은 가벼운 작업용. 싼 모델을 넣으면 비용이 크게 줄어요. 비우면 메인 LLM이 대신합니다.
- **임베딩**(검색 탭): 대화와 기억을 '의미'로 비교해 찾는 기능 — **꼭 켜는 것을 권장**합니다. 임베딩 API 엔드포인트·키·모델을 넣고 켜세요 (Voyage, OpenAI 등). 안 켜면 이름이 정확히 언급된 기억만 찾습니다.

나머지 설정은 그대로 두어도 됩니다. 기본값은 실사용으로 검증된 구성입니다.

### 3. RisuAI에 플러그인 설치

RisuAI → 설정 → 플러그인에서 **플러그인 설치 URL (https://github.com/miladiashe/Omninode-server-plugin)**을 추가합니다 (URL 설치여야 자동 업데이트가 됩니다). 설치 후 RisuAI 설정 메뉴에 생기는 **OmniNode 서버 설정**에서 서버 주소와 토큰(`data/auth-token` 내용)을 넣고 저장하면 연결을 바로 확인해 줍니다.

프롬프트 템플릿에 기억이 들어갈 자리를 넣어주세요 (원작과 같습니다):

```
[omninode.lore]
[omninode.memory]
```

**채팅 갯수 설정**: RisuAI 프롬프트 템플릿에는 채팅을 **(최근 대화 보호 구간) + 9개**만큼 남기도록 설정하세요. 기본 보호 구간이 9이니 처음엔 18개입니다. 최근 대화는 그대로 들어가고, 그 앞 9개는 요약으로 접혀 들어가며, 그 너머는 기억 노드가 대신합니다.

### 4. 채팅에서 켜기

기억 기능은 **채팅마다 명시적으로 켭니다** (기본은 꺼짐 — 안 쓰는 채팅에서 LLM이 돌지 않습니다). 채팅 화면 메뉴의 **🕸️ OmniNode 시작**을 열어:

- **이 채팅에서 OmniNode 사용** 스위치를 켜고
- **봇 타입**을 고릅니다 — 🤖 세계관 봇(기본) / 👤 1인 캐릭터 봇(캐릭터 카드가 항상 함께 들어가므로 캐릭터 본인 기억은 만들지 않음)
- 필요하면 **📚 로어북 임포트**(캐릭터 로어북을 기억 노드로) 또는 **🧊 콜드 스타트**(이미 진행된 긴 채팅의 기억을 한 번에 생성) — 둘 중 하나를 실행하면 스위치는 자동으로 켜집니다.

이제 채팅하면 됩니다. 기억은 8개 메시지마다 배치로 만들어지고, 입력이 멈추면 뒤에서 정리가 돕니다.

---

## 서버 계속 켜두기

터미널을 닫거나 SSH가 끊기면 `npm start`로 띄운 서버는 같이 꺼집니다. 기억 정리는 채팅이 쉴 때 돌기 때문에, 서버는 항상 떠 있어야 합니다.

**Linux (오라클 클라우드 등) — systemd**

```ini
# /etc/systemd/system/omninode.service
[Unit]
Description=OmniNode Server
After=network.target

[Service]
WorkingDirectory=/home/<사용자>/omninode-server
ExecStart=/usr/bin/node dist/index.js
Restart=always
User=<사용자>

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now omninode
```

**macOS — launchd**

`~/Library/LaunchAgents/com.omninode.server.plist`에 `ProgramArguments`를 `node dist/index.js`, `WorkingDirectory`를 리포 경로, `KeepAlive`와 `RunAtLoad`를 `true`로 두고 `launchctl load ~/Library/LaunchAgents/com.omninode.server.plist`.

**안드로이드 폰 — Termux** (아직 실기기 검증 전입니다 — 되면/안 되면 이슈로 알려주세요)

```bash
pkg install nodejs-lts git
# (설치 후 위 "직접 실행" 순서대로 — npm install에서 better-sqlite3가 컴파일되므로 몇 분 걸립니다)
termux-wake-lock          # 화면 꺼져도 잠들지 않게
npm start
```

부팅 시 자동 시작까지 원하면 `termux-services`를 쓰세요. 배터리 최적화 예외에 Termux를 넣어두는 것도 잊지 마세요.

**도커**: `docker-compose.yml`에 `restart: unless-stopped`가 있어 따로 할 일이 없습니다.

---

## 웹 화면

서버 주소를 브라우저로 열면 4개 화면이 있습니다 (다크/라이트 테마 전환은 우측 상단).

| 화면 | 용도 |
|---|---|
| **설정** | LLM·임베딩·검색·주입·기억·프롬프트 전 항목 |
| **대시보드** | 채팅 목록, 백그라운드 작업 이력, 기억 삭제 |
| **그래프** | 기억 노드 그래프를 눈으로 보고 편집·핀·삭제 |
| **주입 뷰어** | 방금 턴에 어떤 기억이 들어갔는지 확인 (회상이 이상할 때 여기부터) |

---

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `OMNINODE_PORT` | `8756` | 포트 |
| `OMNINODE_DATA_DIR` | `./data` (도커: `/data`) | DB·토큰 저장 위치. **백업 = 이 폴더 복사** |
| `OMNINODE_TOKEN` | (자동 생성) | 토큰 직접 지정 (16자 이상) |

## 업데이트

```bash
git pull
npm install
npm run build
# 서버 재시작
```

플러그인은 URL로 설치했다면 RisuAI가 업데이트를 알려줍니다. 서버와 플러그인 버전이 안 맞으면 플러그인이 "같이 업데이트하세요"라고 안내합니다.

## 개발 메모

코드 주석에 보이는 `HANDOFF §…`, `PLAN §…`, `PHASE8-UI` 같은 참조는 비공개 개발 노트를 가리킵니다 — 설계 결정의 출처 표시일 뿐, 공개 리포에는 포함되지 않습니다. 이 리포는 개발용 저장소에서 릴리스마다 스냅샷으로 내보낸 것이라 커밋 이력이 릴리스 단위입니다. 이슈·제안은 GitHub Issues로 주세요.

## 라이선스

MIT. 원작 [OmniNode](https://arca.live/b/characterai/167365522)의 파생작이며 원작자의 허락 하에 배포합니다.
