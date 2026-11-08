/**
 * Array and batch query chunking utilities.
 * PostgREST membership filters (.in('column', values)) fail or overflow URI length limits
 * when passed large arrays (often throwing opaque errors like `[object Object]`).
 * Use `chunkArray` to safely partition unbounded lists before performing PostgREST `.in()` queries.
 */

export function chunkArray<T>(items: T[], size = 100): T[][] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}
