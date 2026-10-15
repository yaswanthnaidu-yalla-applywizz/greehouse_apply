import type { ScannedField, ScannedJobTemplate } from '../types/index.js';

const SECURITY_CLEARANCE_TERMS =
  /\b(?:clearance|cleared|public\s+trust|top\s+secret|ts\s*\/?\s*sci|classified)\b/i;

export function isSecurityClearanceQuestion(
  field: Pick<ScannedField, 'fieldId' | 'name' | 'label' | 'metadata'>
): boolean {
  const text = [field.fieldId, field.name, field.label, ...Object.values(field.metadata || {})]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .replace(/[_-]+/g, ' ');
  return SECURITY_CLEARANCE_TERMS.test(text);
}

export function hasSecurityClearanceQuestion(template: ScannedJobTemplate): boolean {
  return template.fields.some(isSecurityClearanceQuestion);
}
