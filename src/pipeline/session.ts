// 채팅별 세션 — 원본 모듈 8의 전역 상태(nodeStore/diffManager/currentChatKey/
// _prevInjectedNodeIds/lastKnownMsgCount/_pipelineLock)를 채팅 단위로 캡슐화한다.
// 그래프는 램 상주가 원칙: 최초 접근 시 repo에서 로드해 세션 맵에 유지.
import { OmniNodeStore } from '../core/node-store.js';
import { DiffManager } from '../core/diff-manager.js';
import type { ChatStateRepo } from '../persistence/chat-state-repo.js';

export class ChatSession {
  prevInjectedNodeIds: string[] = [];
  // 서버 재시작 후 0에서 시작 — 첫 요청은 리롤/롤백 판정 없이 기준점만 갱신됨
  lastKnownMsgCount = 0;
  // 리롤 오인 방지용 마지막 채팅 메시지 내용 해시 (비영속 — lastKnownMsgCount와 동일 한계).
  // 메시지 수가 같아도 내용이 다르면 리롤이 아니라 별개 채팅 의심 (HANDOFF §1.5 챗 복사 사고)
  lastKnownLastMsgHash = '';
  // 마지막 파이프라인의 페르소나 이름 — 백그라운드 잡(월드심/LTM)이 재사용 (비영속)
  lastPersonaName = '';
  // 마지막 파이프라인의 캐릭터 카드 이름 — 백그라운드 LTM/콜드스타트 잡이 재사용 (비영속)
  lastCharName = '';
  // 챗 복사 감지에서 승계 포기 판정을 받았음 — 턴마다 클론 재시도하는 낭비 방지 (비영속)
  copyInheritSkipped = false;
  // 옵트인 판정용 복사 탐색을 이미 시도했음 — unset+빈 그래프의 후속 턴에서 재탐색 방지 (비영속)
  copyOptInChecked = false;
  // 파이프라인 요청이 세션 락을 기다리는 중인지 — dream 잡이 태스크 사이에 보고 조기 양보
  // (원본 _pipelineLock 협조 중단의 서버판)
  pipelineWaiting = 0;
  // 마지막 턴 주입 내역 (회상 검증용 — GET /api/chats/:chatKey/last-injection, 비영속)
  lastInjection: {
    turn: number;
    at: number;
    keywords: string[];
    nodes: Array<{ id: string; type: string; name: string; content: string }>;
    summary: string;
  } | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    public readonly chatKey: string,
    public store: OmniNodeStore,
    public diffManager: DiffManager,
    public simulBot = true,
    // undefined는 명시 설정 없음. 이 상태에서는 노드 보유 여부로 매번 파생한다.
    public enabled: boolean | undefined = undefined,
  ) {}

  isEnabled(): boolean {
    return this.enabled ?? this.store.getNodeCount() > 0;
  }

  // 파이프라인 동시 실행 방지 — 원본 _pipelineLock의 세션판.
  // 이전 실행이 실패해도 다음 실행은 진행된다.
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }
}

export class SessionManager {
  private sessions = new Map<string, ChatSession>();

  constructor(private repo: ChatStateRepo) {}

  get(chatKey: string): ChatSession {
    let session = this.sessions.get(chatKey);
    if (!session) {
      const { store, diffManager, simulBot, enabled } = this.repo.load(chatKey);
      session = new ChatSession(chatKey, store, diffManager, simulBot, enabled);
      this.sessions.set(chatKey, session);
    }
    return session;
  }

  // 세션이 램에 있는지만 확인 (get과 달리 로드 부작용 없음)
  has(chatKey: string): boolean {
    return this.sessions.has(chatKey);
  }

  drop(chatKey: string) {
    this.sessions.delete(chatKey);
  }

  keys(): string[] {
    return [...this.sessions.keys()];
  }
}
