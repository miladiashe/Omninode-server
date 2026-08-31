import { describe, expect, it } from 'vitest';
import { SETTINGS_HTML } from '../src/web/settings-page.js';

describe('settings page prompt cards', () => {
  it('로어 정정 메모 병합 프롬프트 카드를 렌더한다', () => {
    expect(SETTINGS_HTML).toContain('id="p_lore_compact"');
  });
});
