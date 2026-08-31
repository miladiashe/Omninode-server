// 시드 기반 결정적 픽스처 생성기. 같은 시드 → 항상 같은 직렬화 상태.
// 원본 serialize() v1 포맷을 흉내내되, 관계 타입 정규화·차원 불일치 스킵 같은
// 엣지 케이스를 일부러 섞는다.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randVec(rand: () => number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rand() * 2 - 1;
  return v;
}

export function f32ToStdBase64(f32: Float32Array): string {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

const WORDS = ['마법', '검', '왕국', '기사', '용', '숲', '항구', '연금술', '별', '탑', 'guild', 'oath', 'ruin', 'ember', 'tide'];
const REL_TYPES_DIRTY = ['causes', 'ENABLES', 'prevents', 'weird_type', 'develops', 'related', 'parent', '', 'Contradicts'];

export function makeFixture(seed: number) {
  const rand = mulberry32(seed);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const ids: string[] = [];

  const makeRaw = (id: string, type: string, i: number) => {
    const rels = [];
    const relCount = Math.floor(rand() * 3);
    for (let r = 0; r < relCount && ids.length > 0; r++) {
      rels.push({
        targetId: pick(ids),
        type: pick(REL_TYPES_DIRTY),
        // direction/strength를 일부러 자주 누락시켜 기본값 경로를 태운다
        ...(rand() < 0.5 ? { direction: rand() < 0.5 ? 'uni' : 'bi' } : {}),
        ...(rand() < 0.6 ? { strength: Math.floor(rand() * 9) } : {}),
        ...(rand() < 0.5 ? { createdAtTurn: Math.floor(rand() * 50) } : {}),
      });
    }
    ids.push(id);
    const raw: Record<string, unknown> = {
      id,
      type,
      name: `${type}-${i} ${pick(WORDS)}`,
      content: `${pick(WORDS)}에 대한 기록 ${i}: ${pick(WORDS)}와 ${pick(WORDS)}의 이야기. `.repeat(1 + Math.floor(rand() * 4)),
      keywords: [pick(WORDS), pick(WORDS), `kw${i % 7}`],
      globalKeywords: rand() < 0.5 ? [pick(WORDS)] : [],
      importance: 1 + Math.floor(rand() * 7), // 범위 밖 값도 섞어 클램프 경로 검증
      activationScore: rand() * 110 - 5,
      utilityScore: rand() * 100,
      creationTurn: Math.floor(rand() * 100),
      relationships: rels,
      zeroScoreTurns: Math.floor(rand() * 5),
      highScoreTurns: Math.floor(rand() * 30),
      alwaysActive: rand() < 0.1,
      archived: rand() < 0.2,
      excluded: rand() < 0.05,
      timestamp: rand() < 0.5 ? `26${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}15${String(Math.floor(rand() * 24)).padStart(2, '0')}30` : null,
    };
    if (rand() < 0.2) raw.sourceNodeIds = ids.slice(0, 1 + Math.floor(rand() * 2));
    if (rand() < 0.1) raw.worldSim = true;
    return raw;
  };

  const loreNodes = Array.from({ length: 8 }, (_, i) => makeRaw(`ln_fix_${i}`, 'lore', i));
  const extraLoreNodes = Array.from({ length: 20 }, (_, i) => makeRaw(`eln_fix_${i}`, 'extraLore', i));
  const communityNodes = Array.from({ length: 5 }, (_, i) => {
    const raw = makeRaw(`csn_fix_${i}`, 'communitySummary', i);
    raw.communityId = `comm_${i}`;
    raw.level = Math.floor(rand() * 2);
    raw.memberNodeIds = ids.slice(0, 2 + Math.floor(rand() * 4));
    raw.parentCommunityId = i > 2 ? 'csn_fix_0' : null;
    return raw;
  });
  const longTermMemoryNodes = Array.from({ length: 12 }, (_, i) => makeRaw(`ltm_fix_${i}`, 'longTermMemory', i));

  const DIM = 8;
  const embeddingCache = ids.slice(0, 10).map((nodeId, i) => ({
    nodeId,
    hash: `h${i}`,
    embedding: f32ToStdBase64(randVec(rand, DIM)),
  }));
  // 차원 불일치 엔트리 (skip 경로 검증)
  embeddingCache.push({ nodeId: 'eln_fix_1', hash: 'h_bad', embedding: f32ToStdBase64(randVec(rand, DIM * 2)) });
  // 레거시 number[] 엔트리
  embeddingCache.push({ nodeId: 'ltm_fix_2', hash: 'h_legacy', embedding: Array.from(randVec(rand, DIM)) as unknown as string });

  const textEmbeddingCache = Array.from({ length: 6 }, (_, i) => ({
    hash: `th${i}`,
    embedding: f32ToStdBase64(randVec(rand, DIM)),
  }));

  const hydeCache = Array.from({ length: 4 }, (_, i) => ({
    hash: `hy${i}`,
    hydeStr: `hyde text ${i} ${pick(WORDS)}`,
    embedding: rand() < 0.7 ? f32ToStdBase64(randVec(rand, DIM)) : null,
  }));

  const memrlCache = Array.from({ length: 8 }, (_, i) => ({
    key: `${pick(ids)}_mr${i}`,
    useful: rand() < 0.5,
    confidence: Math.round(rand() * 100) / 100,
    turn: Math.floor(rand() * 40),
  }));

  return {
    version: 1,
    currentTurn: 42,
    atlasMd: '# Atlas\n주요 지식 요약',
    loreNodes,
    extraLoreNodes,
    communityNodes,
    longTermMemoryNodes,
    embeddingCache,
    textEmbeddingCache,
    hydeCache,
    memrlCache,
    lastCommunityTurn: 30,
    nodesSinceLastCommunity: 7,
    lastConvertedMsgCount: 11,
    ltmConvertedUpTo: 25,
    lastChapterTurn: 20,
    _allIds: ids,
  };
}
