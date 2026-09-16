import type { ResolvedField } from '../types/index.js';

export function hasNonEmptyResolvedFieldValue(field: ResolvedField): boolean {
  const v = field?.value;
  if (v === null || v === undefined) return false;
  return String(v).trim().length > 0;
}

export function hasAnyNonEmptyResolvedField(fields: unknown): boolean {
  if (!Array.isArray(fields)) return false;
  return fields.some((f) => hasNonEmptyResolvedFieldValue(f as ResolvedField));
}
