import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLoreEntrySources,
  collectModules,
  mergeEnabledModuleIds,
  type ModuleSummary,
} from '../plugin/src/lorebook.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('plugin module lorebook helpers', () => {
  it('켜진 모듈 합집합은 DB→챗→캐릭터→연동 순서를 유지하며 중복을 제거한다', () => {
    expect(mergeEnabledModuleIds(
      ['db-a', 'shared'],
      ['chat-a', 'shared'],
      ['character-a', 'db-a'],
      ' integration-a, shared, integration-b ',
    )).toEqual(['db-a', 'shared', 'chat-a', 'character-a', 'integration-a', 'integration-b']);
  });

  it('DB 권한 요청을 거부하면 collectModules는 null을 반환한다', async () => {
    const getDatabase = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('risuai', { getDatabase });

    await expect(collectModules()).resolves.toBeNull();
    expect(getDatabase).toHaveBeenCalledWith(['modules', 'enabledModules', 'moduleIntergration']);
  });

  it('모듈 엔트리를 출처·모듈 ID와 모듈별 연속 originalIndex를 붙여 합친다', () => {
    const modules: ModuleSummary[] = [
      {
        id: 'module-a',
        name: '모듈 A',
        description: '',
        entryCount: 2,
        lorebook: [{ content: 'A0' }, { content: 'A1' }],
      },
      {
        id: 'module-b',
        name: '모듈 B',
        description: '',
        entryCount: 1,
        lorebook: [{ content: 'B0' }],
      },
    ];

    const merged = buildLoreEntrySources(
      [{ content: 'global' }],
      [{ content: 'local' }],
      modules,
    );

    expect(merged.map(({ source, originalIndex, moduleId, moduleName }) => ({
      source,
      originalIndex,
      moduleId,
      moduleName,
    }))).toEqual([
      { source: 'global', originalIndex: 0, moduleId: undefined, moduleName: undefined },
      { source: 'local', originalIndex: 1, moduleId: undefined, moduleName: undefined },
      { source: 'module', originalIndex: 0, moduleId: 'module-a', moduleName: '모듈 A' },
      { source: 'module', originalIndex: 1, moduleId: 'module-a', moduleName: '모듈 A' },
      { source: 'module', originalIndex: 0, moduleId: 'module-b', moduleName: '모듈 B' },
    ]);
  });
});
