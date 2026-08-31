// GLM 5.2 실측 회귀 테스트 (2026-08-31): 생각 모델이 JSON 문자열 값 안에
// 생 줄바꿈을 넣어 보내던 실패 — data/debug/agent-parse-fail-1788135388764.txt 축약 재현.
import { describe, it, expect } from 'vitest';
import { robustParseJSON } from '../src/core/util.js';

describe('robustParseJSON — 문자열 내 생 제어문자 (GLM 5.2)', () => {
  it('문자열 값 안의 생 줄바꿈·탭을 이스케이프해 파싱한다', () => {
    const raw = '```json\n{\n  "nodes": [\n    {\n      "tempId": "_n1",\n      "op": "create",\n      "content": "### 제목\n\n- Time: 오후\n- Location:\t항구"\n    }\n  ],\n  "reevaluations": [\n    { "nodeId": "x", "newDetail": "줄1\n줄2" }\n  ]\n}\n```';
    const parsed = robustParseJSON(raw) as { nodes: Array<{ content: string }>; reevaluations: unknown[] };
    expect(parsed).not.toBeNull();
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0].content).toBe('### 제목\n\n- Time: 오후\n- Location:\t항구');
    expect(parsed.reevaluations).toHaveLength(1);
  });

  it('합법 JSON(토큰 사이 줄바꿈)은 그대로 통과한다', () => {
    expect(robustParseJSON('{\n  "a": "b\\nc"\n}')).toEqual({ a: 'b\nc' });
  });

  it('이스케이프된 따옴표가 있는 문자열 안 줄바꿈도 처리한다', () => {
    expect(robustParseJSON('{"a": "그가 \\"안녕\n하세요\\"라 했다"}'))
      .toEqual({ a: '그가 "안녕\n하세요"라 했다' });
  });
});
