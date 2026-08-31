// 원본 MODULE 9: GIT DIFF ROLLBACK (L8028–8333)의 이식. 로직 동일 유지.
import { OmniNodeStore, createNode, NODE_EXTRA_FIELDS, type OmniNode } from './node-store.js';
import { LOG_PREFIX } from './util.js';

export interface NodeDiff {
  added: Array<Record<string, unknown>>;
  removed: string[];
  modified: Array<Record<string, unknown>>;
}

export interface Snapshot {
  type: 'BASE' | 'DIFF';
  turn: number;
  timestamp: number;
  nodeState?: Record<string, unknown>;
  diff?: NodeDiff;
  atlasMd?: string;
  ltmConvertedUpTo?: number;
  ltmWatermarkHash?: string;
  lastConvertedMsgCount?: number;
  lastCommunityTurn?: number;
  nodesSinceLastCommunity?: number;
  lastChapterTurn?: number;
}

export class DiffManager {
  snapshots: Snapshot[] = [];
  maxSnapshots = 50;
  _diffsSinceLastBase = 0;
  _autoBaseInterval = 10; // Auto-create BASE every N DIFFs for chain integrity

  _recalcDiffCounter() {
    this._diffsSinceLastBase = 0;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].type === 'BASE' || this.snapshots[i].nodeState) break;
      this._diffsSinceLastBase++;
    }
  }

  private _recordScalarState(snap: Snapshot, ns: OmniNodeStore, fallback: OmniNodeStore) {
    const values = {
      ltmConvertedUpTo: ns._ltmConvertedUpTo,
      ltmWatermarkHash: ns._ltmWatermarkHash,
      lastConvertedMsgCount: ns._lastConvertedMsgCount,
      lastCommunityTurn: ns._lastCommunityTurn,
      nodesSinceLastCommunity: ns._nodesSinceLastCommunity,
      lastChapterTurn: ns._lastChapterTurn,
    };
    const fallbackValues = {
      ltmConvertedUpTo: fallback._ltmConvertedUpTo,
      ltmWatermarkHash: fallback._ltmWatermarkHash,
      lastConvertedMsgCount: fallback._lastConvertedMsgCount,
      lastCommunityTurn: fallback._lastCommunityTurn,
      nodesSinceLastCommunity: fallback._nodesSinceLastCommunity,
      lastChapterTurn: fallback._lastChapterTurn,
    };
    for (const key of Object.keys(values) as Array<keyof typeof values>) {
      // BASE/nodeState already persists equal values. Keeping those redundant properties
      // non-enumerable preserves the original snapshot bytes while changed DIFF scalars persist.
      Object.defineProperty(snap, key, {
        value: values[key],
        enumerable: values[key] !== fallbackValues[key],
        configurable: true,
        writable: true,
      });
    }
  }

  async takeDiff(ns: OmniNodeStore, type: 'BASE' | 'DIFF' = 'DIFF') {
    // First snapshot must always be BASE for chain integrity
    if (this.snapshots.length === 0 && type === 'DIFF') type = 'BASE';

    // Reroll dedup: if last snapshot has the same turn, replace it
    if (this.snapshots.length > 0 && type !== 'BASE') {
      const lastSnap = this.snapshots[this.snapshots.length - 1];
      if (lastSnap.turn === ns.currentTurn) {
        const removed = this.snapshots.pop()!;
        if (removed.type === 'BASE' || removed.nodeState) {
          this._recalcDiffCounter();
        } else {
          this._diffsSinceLastBase = Math.max(0, this._diffsSinceLastBase - 1);
        }
      }
    }

    // Auto-BASE: after N consecutive DIFFs, force BASE for chain performance
    if (type === 'DIFF' && this._diffsSinceLastBase >= this._autoBaseInterval) {
      type = 'BASE';
    }

    if (type === 'BASE') {
      // serializeFull: 원본은 serialize()를 써서 커뮤니티 필드·발췌 앵커가 롤백 시 유실됐다
      // (원본 serialize 버그의 전파 — 의도적 이탈 수정 2026-08-02)
      const snap: Snapshot = {
        type: 'BASE', turn: ns.currentTurn, timestamp: Date.now(),
        nodeState: ns.serializeFull(), atlasMd: ns.atlasMd || '',
      };
      this._recordScalarState(snap, ns, ns);
      this.snapshots.push(snap);
      this._diffsSinceLastBase = 0;
    } else {
      const prevNs = this.snapshots.length > 0 ? this.resolveState(this.snapshots.length - 1) : null;
      const diff = await this._computeDiff(prevNs, ns);

      // Skip empty diffs — no node changes and no metadata changes
      const prevAt = prevNs ? prevNs.atlasMd || '' : '';
      const atChanged = (ns.atlasMd || '') !== prevAt;
      const scalarChanged = !!prevNs && (
        ns._ltmConvertedUpTo !== prevNs._ltmConvertedUpTo
        || ns._ltmWatermarkHash !== prevNs._ltmWatermarkHash
        || ns._lastConvertedMsgCount !== prevNs._lastConvertedMsgCount
        || ns._lastCommunityTurn !== prevNs._lastCommunityTurn
        || ns._nodesSinceLastCommunity !== prevNs._nodesSinceLastCommunity
        || ns._lastChapterTurn !== prevNs._lastChapterTurn
      );
      if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0 && !atChanged && !scalarChanged) {
        return;
      }

      const snap: Snapshot = { type: 'DIFF', turn: ns.currentTurn, timestamp: Date.now(), diff };
      if (atChanged) snap.atlasMd = ns.atlasMd || '';
      this._recordScalarState(snap, ns, prevNs ?? ns);
      this.snapshots.push(snap);
      this._diffsSinceLastBase++;
    }
    if (this.snapshots.length > this.maxSnapshots) {
      const excess = this.snapshots.length - this.maxSnapshots;
      // Find oldest DIFF snapshots to trim, but always keep the most recent BASE
      // and ensure at least one BASE survives for DIFF chain integrity
      const trimCandidates: number[] = [];
      for (let i = 0; i < this.snapshots.length - 1; i++) {
        if (this.snapshots[i].type !== 'BASE' && !this.snapshots[i].nodeState) {
          trimCandidates.push(i);
        }
      }
      if (trimCandidates.length >= excess) {
        const toRemove = new Set(trimCandidates.slice(0, excess));
        this.snapshots = this.snapshots.filter((_, i) => !toRemove.has(i));
      } else {
        const lastBaseIdx = this.snapshots.reduce((best, s, i) => (s.type === 'BASE' || s.nodeState) ? i : best, -1);
        const removeCount = Math.min(excess, lastBaseIdx > 0 ? lastBaseIdx : excess);
        this.snapshots.splice(0, removeCount);
      }
      this._recalcDiffCounter();
    }
  }

  async _computeDiff(prevNs: OmniNodeStore | null, currentNs: OmniNodeStore): Promise<NodeDiff> {
    const prevNodes = prevNs ? prevNs.getAllNodes() : [];
    const currNodes = currentNs.getAllNodes();
    const prevMap = new Map(prevNodes.map(n => [n.id, n]));
    const added: Array<Record<string, unknown>> = [], removed: string[] = [], modified: Array<Record<string, unknown>> = [];

    for (const node of currNodes) {
      if (!prevMap.has(node.id)) {
        const entry: Record<string, unknown> = {
          id: node.id, type: node.type, name: node.name || '', content: node.content,
          keywords: [...node.keywords], globalKeywords: [...(node.globalKeywords || [])],
          importance: node.importance, activationScore: node.activationScore,
          creationTurn: node.creationTurn, relationships: node.relationships.map(r => ({ ...r })),
          zeroScoreTurns: node.zeroScoreTurns || 0, highScoreTurns: node.highScoreTurns || 0,
          alwaysActive: node.alwaysActive || false,
          utilityScore: node.utilityScore ?? 50, archived: node.archived || false,
          timestamp: node.timestamp ?? null,
        };
        // 보충 필드 동반 (커뮤니티 멤버·발췌 앵커 등 — 원본은 미기록이라 롤백 시 유실됐음)
        const liveRec = node as unknown as Record<string, unknown>;
        for (const k of NODE_EXTRA_FIELDS) {
          if (liveRec[k] !== undefined) entry[k] = liveRec[k];
        }
        added.push(entry);
      } else {
        const prev = prevMap.get(node.id)!;
        const ch: Record<string, unknown> = {};
        if (prev.name !== node.name) ch.name = node.name;
        if (prev.content !== node.content) ch.content = node.content;
        if (prev.importance !== node.importance) ch.importance = node.importance;
        if (prev.activationScore !== node.activationScore) ch.activationScore = node.activationScore;
        if (!this._arraysShallowEqual(prev.keywords, node.keywords)) ch.keywords = [...node.keywords];
        if (!this._arraysShallowEqual(prev.globalKeywords || [], node.globalKeywords || [])) ch.globalKeywords = [...(node.globalKeywords || [])];
        if (!this._relationsEqual(prev.relationships, node.relationships)) ch.relationships = node.relationships.map(r => ({ ...r }));
        if ((prev.zeroScoreTurns || 0) !== (node.zeroScoreTurns || 0)) ch.zeroScoreTurns = node.zeroScoreTurns;
        if ((prev.highScoreTurns || 0) !== (node.highScoreTurns || 0)) ch.highScoreTurns = node.highScoreTurns;
        if ((prev.utilityScore ?? 50) !== (node.utilityScore ?? 50)) ch.utilityScore = node.utilityScore;
        if ((prev.archived || false) !== (node.archived || false)) ch.archived = node.archived;
        if ((prev.timestamp ?? null) !== (node.timestamp ?? null)) ch.timestamp = node.timestamp ?? null;
        // 보충 필드 변경 추적 (커뮤니티 업데이트가 memberNodeIds를 제자리 갱신하는 경우 등)
        {
          const prevRec = prev as unknown as Record<string, unknown>;
          const nodeRec = node as unknown as Record<string, unknown>;
          for (const k of NODE_EXTRA_FIELDS) {
            if (JSON.stringify(prevRec[k]) !== JSON.stringify(nodeRec[k])) ch[k] = nodeRec[k];
          }
        }
        if (Object.keys(ch).length > 0) modified.push({ id: node.id, ...ch });
        prevMap.delete(node.id);
      }
    }
    for (const [id] of prevMap) removed.push(id);
    return { added, removed, modified };
  }

  _arraysShallowEqual(a: unknown[] | null | undefined, b: unknown[] | null | undefined): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  _relationsEqual(a: OmniNode['relationships'], b: OmniNode['relationships']): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].targetId !== b[i].targetId || a[i].type !== b[i].type ||
        a[i].direction !== b[i].direction || a[i].strength !== b[i].strength ||
        (a[i].createdAtTurn ?? 0) !== (b[i].createdAtTurn ?? 0)) return false;
    }
    return true;
  }

  _applyDiff(ns: OmniNodeStore, snap: Snapshot) {
    const diff = snap.diff;
    if (!diff) return;
    for (const id of (diff.removed || [])) {
      ns.loreNodes.delete(id); ns.extraLoreNodes.delete(id); ns.communityNodes.delete(id); ns.longTermMemoryNodes.delete(id);
      ns.embeddingCache.delete(id);
    }
    for (const n of (diff.added || []) as Array<Record<string, any>>) {
      if (n.type === 'conversation') {
        console.warn(`${LOG_PREFIX} DiffManager: ignored legacy conversation node ${n.id || '(unknown id)'}`);
        continue;
      }
      const node = createNode(n as Parameters<typeof createNode>[0]);
      node.id = n.id;
      node.zeroScoreTurns = n.zeroScoreTurns || 0;
      node.highScoreTurns = n.highScoreTurns || 0;
      node.utilityScore = n.utilityScore ?? 50;
      node.archived = n.archived || false;
      const nodeRec = node as unknown as Record<string, unknown>;
      for (const k of NODE_EXTRA_FIELDS) {
        if (n[k] !== undefined) nodeRec[k] = n[k];
      }
      if (n.type === 'lore') ns.loreNodes.set(n.id, node);
      else if (n.type === 'extraLore') ns.extraLoreNodes.set(n.id, node);
      else if (n.type === 'communitySummary') ns.communityNodes.set(n.id, node);
      else ns.longTermMemoryNodes.set(n.id, node);
    }
    for (const mod of (diff.modified || [])) {
      const node = ns.getNode(mod.id as string) as Record<string, unknown> | null;
      if (!node) {
        console.warn(`${LOG_PREFIX} DiffManager: modified node ${mod.id} not found, skipping`);
        continue;
      }
      for (const [key, val] of Object.entries(mod)) {
        if (key !== 'id') node[key] = val;
      }
    }
    if (snap.atlasMd !== undefined) ns.atlasMd = snap.atlasMd;
    ns.currentTurn = snap.turn;
    ns._invalidateNodeCaches();
    ns._rebuildReverseRelIndex();
  }

  resolveState(index: number): OmniNodeStore {
    if (index < 0 || !this.snapshots.length) return new OmniNodeStore();
    if (index >= this.snapshots.length) index = this.snapshots.length - 1;
    const snap = this.snapshots[index];
    // Legacy or BASE with nodeState — deserialize directly
    if (snap.nodeState) {
      const ns = OmniNodeStore.deserialize(snap.nodeState);
      ns.atlasMd = snap.atlasMd || ns.atlasMd || '';
      return ns;
    }
    // DIFF — find nearest BASE (or legacy with nodeState) before this
    let baseIdx = -1;
    for (let i = index - 1; i >= 0; i--) {
      if (this.snapshots[i].nodeState || this.snapshots[i].type === 'BASE') { baseIdx = i; break; }
    }
    let ns: OmniNodeStore;
    if (baseIdx >= 0) {
      ns = OmniNodeStore.deserialize(this.snapshots[baseIdx].nodeState);
      ns.atlasMd = this.snapshots[baseIdx].atlasMd || ns.atlasMd || '';
    } else {
      console.warn(`${LOG_PREFIX} DiffManager: no BASE snapshot found before index ${index}, starting from empty state`);
      ns = new OmniNodeStore();
    }
    for (let i = (baseIdx >= 0 ? baseIdx + 1 : 0); i <= index; i++) {
      if (this.snapshots[i].nodeState) continue;
      this._applyDiff(ns, this.snapshots[i]);
    }
    return ns;
  }

  deleteSnapshot(index: number): boolean {
    if (index >= 0 && index < this.snapshots.length) {
      this.snapshots.splice(index, 1);
      this._recalcDiffCounter();
      return true;
    }
    return false;
  }

  rollbackTo(turn: number, ns: OmniNodeStore, isReroll = false): boolean {
    let bestIdx = -1;
    for (let i = 0; i < this.snapshots.length; i++) {
      if (isReroll ? this.snapshots[i].turn < turn : this.snapshots[i].turn <= turn) {
        bestIdx = i;
      }
    }

    if (bestIdx < 0) {
      console.log(`${LOG_PREFIX} No snapshot found for rollback to turn ${turn}`);
      if (isReroll) {
        for (const node of ns.getAllNodes()) {
          if (node.type !== 'lore') {
            node.activationScore = Math.max(0, node.activationScore - 1.0);
          }
        }
      }
      return false;
    }

    const restored = this.resolveState(bestIdx);
    const bestSnapshot = this.snapshots[bestIdx];
    ns.loreNodes = restored.loreNodes;
    ns.extraLoreNodes = restored.extraLoreNodes;
    ns.communityNodes = restored.communityNodes;
    ns.longTermMemoryNodes = restored.longTermMemoryNodes;
    ns.atlasMd = restored.atlasMd || '';
    ns.currentTurn = restored.currentTurn;
    ns._lastConvertedMsgCount = bestSnapshot.lastConvertedMsgCount !== undefined
      ? bestSnapshot.lastConvertedMsgCount : restored._lastConvertedMsgCount || 0;
    ns._ltmConvertedUpTo = bestSnapshot.ltmConvertedUpTo !== undefined
      ? bestSnapshot.ltmConvertedUpTo : restored._ltmConvertedUpTo || 0;
    ns._lastCommunityTurn = bestSnapshot.lastCommunityTurn !== undefined
      ? bestSnapshot.lastCommunityTurn : restored._lastCommunityTurn || 0;
    ns._nodesSinceLastCommunity = bestSnapshot.nodesSinceLastCommunity !== undefined
      ? bestSnapshot.nodesSinceLastCommunity : restored._nodesSinceLastCommunity || 0;
    ns._ltmWatermarkHash = bestSnapshot.ltmWatermarkHash !== undefined
      ? bestSnapshot.ltmWatermarkHash : restored._ltmWatermarkHash || '';
    ns._lastChapterTurn = bestSnapshot.lastChapterTurn !== undefined
      ? bestSnapshot.lastChapterTurn : restored._lastChapterTurn || 0;
    // Invalidate cached counts/lists — maps were replaced so old caches are stale
    ns._invalidateNodeCaches();
    ns._rebuildReverseRelIndex();
    for (const key of ns.embeddingCache.keys()) {
      if (!ns.getNode(key)) ns.embeddingCache.delete(key);
    }

    // 복원한 시점 이후의 스냅샷은 폐기
    this.snapshots = this.snapshots.slice(0, bestIdx + 1);
    this._recalcDiffCounter();
    console.log(`${LOG_PREFIX} Rolled back to turn ${restored.currentTurn} (Target: ${turn}, isReroll: ${isReroll})`);
    return true;
  }

  getSnapshotCount(): number {
    return this.snapshots.length;
  }

  serialize(): Snapshot[] {
    return this.snapshots;
  }

  deserialize(data: unknown) {
    try {
      if (typeof data === 'string' && data) this.snapshots = JSON.parse(data) || [];
      else if (Array.isArray(data)) this.snapshots = data;
      else this.snapshots = [];
      this.snapshots = this.snapshots.map(snapshot => {
        const cleaned = { ...snapshot } as Record<string, any>;
        delete cleaned.writerMd;
        delete cleaned.chatMd;
        if (cleaned.nodeState && typeof cleaned.nodeState === 'object' && !Array.isArray(cleaned.nodeState)) {
          cleaned.nodeState = { ...cleaned.nodeState };
          delete cleaned.nodeState.writerMd;
          delete cleaned.nodeState.chatMd;
        }
        return cleaned as Snapshot;
      });
    } catch {
      this.snapshots = [];
    }
    this._recalcDiffCounter();
  }
}
