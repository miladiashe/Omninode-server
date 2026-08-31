// Math.random / performance.now / Date.now 스텁 — 호스트 전역을 바꾸므로
// (참조 샌드박스도 호스트 객체를 공유) 이식본과 참조 구현이 같은 스트림을 본다.
import { mulberry32 } from './fixture.js';

export function stubMathRandom(seed: number): () => void {
  const orig = Math.random;
  const rng = mulberry32(seed);
  Object.defineProperty(Math, 'random', { value: rng, configurable: true, writable: true });
  return () => Object.defineProperty(Math, 'random', { value: orig, configurable: true, writable: true });
}

export function reseedMathRandom(seed: number): void {
  Object.defineProperty(Math, 'random', { value: mulberry32(seed), configurable: true, writable: true });
}

export function stubPerformanceNow(value = 0): () => void {
  const orig = performance.now;
  Object.defineProperty(performance, 'now', { value: () => value, configurable: true, writable: true });
  return () => Object.defineProperty(performance, 'now', { value: orig, configurable: true, writable: true });
}

// 주의: 증가 카운터 방식은 테스트 프레임워크가 중간에 Date.now()를 호출하면
// 오염되어 비결정적이 된다. 고정값을 반환해 프레임워크 개입을 무해화한다.
export function stubDateNow(value = 1_000_000): () => void {
  const orig = Date.now;
  Object.defineProperty(Date, 'now', { value: () => value, configurable: true, writable: true });
  return () => Object.defineProperty(Date, 'now', { value: orig, configurable: true, writable: true });
}

export function resetDateNow(value = 1_000_000): void {
  Object.defineProperty(Date, 'now', { value: () => value, configurable: true, writable: true });
}
