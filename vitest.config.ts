import { defineConfig } from 'vitest/config';

// .release/ 는 export-release.mts 의 공개 리포 스테이징 — 그 안의 test/ 를 긁으면
// 원작 참조 파일이 없어 차분 테스트가 실패하며 개발 리포 검증이 오염된다.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.release/**', '**/reference/**'],
  },
});
