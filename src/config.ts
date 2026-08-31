import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 플러그인과의 호환성 계약 버전. 요청/응답 형태가 깨지는 변경 시에만 올린다.
export const API_VERSION = 1;

export interface Config {
  port: number;
  dataDir: string;
  token: string;
}

function loadOrCreateToken(dataDir: string): string {
  const fromEnv = process.env.OMNINODE_TOKEN;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (fromEnv) {
    console.warn('[config] OMNINODE_TOKEN이 16자 미만이라 무시합니다. 자동 생성 토큰을 사용합니다.');
  }

  const tokenPath = join(dataDir, 'auth-token');
  if (existsSync(tokenPath)) {
    const saved = readFileSync(tokenPath, 'utf8').trim();
    if (saved.length >= 16) return saved;
  }

  const token = randomBytes(24).toString('base64url');
  writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  console.log(`[config] 인증 토큰을 새로 생성했습니다: ${tokenPath}`);
  console.log(`[config] 플러그인 설정에 입력할 토큰: ${token}`);
  return token;
}

export function loadConfig(): Config {
  const dataDir = process.env.OMNINODE_DATA_DIR ?? join(process.cwd(), 'data');
  mkdirSync(dataDir, { recursive: true });

  return {
    port: Number(process.env.OMNINODE_PORT ?? 8756),
    dataDir,
    token: loadOrCreateToken(dataDir),
  };
}
