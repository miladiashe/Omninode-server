import type { MiddlewareHandler } from 'hono';

// /api/health를 제외한 모든 /api/* 경로에 적용한다.
// health는 플러그인의 폴백 판단(서버 생존 확인)용이라 무인증으로 둔다.
export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    if (header !== `Bearer ${token}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
    return; // noImplicitReturns 대응 — Hono 미들웨어의 next() 경로는 반환값 없음이 정상
  };
}
