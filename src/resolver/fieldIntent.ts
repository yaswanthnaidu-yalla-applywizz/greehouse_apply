import type { FieldFamily, FieldIntent, ScannedField } from '../types/index.js';

export interface EvidenceDescriptor { kind: string; key?: string; value?: unknown }

export function classifyFieldIntent(field: ScannedField): FieldIntent {
  const options = (field.options || []).join(' ').toLowerCase();
  const text = `${field.label} ${field.name} ${field.fieldId}`.toLowerCase();
  if (/sms|text message|whatsapp/.test(options) && /yes|no|consent|agree|opt/.test(options)) return { family: 'agreement_consent', qualifier: 'sms' };
  if (/phone|telephone|mobile/.test(text) && (field.metadata?.inputType === 'tel' || field.type === 'text')) return { family: 'contact_profile' };
  const rules: Array<[RegExp, FieldFamily]> = [
    [/current\s*(\/|or|and|last)?\s*company|employer|worked here/, 'employer_history'],
    [/work authorization|authorized to work|visa/, 'work_authorization'],
    [/sponsor/, 'sponsorship'],
    [/felony|conviction|legal history/, 'legal_history'],
    [/sms|text message|whatsapp|consent|privacy|recording|agree|agreement/, 'agreement_consent'],
    [/workplace|office|onsite|on-site|remote|relocat|work location/, 'workplace_preference'],
    [/residen|current city|current state|current country|live in/, 'residence'],
    [/salary|compensation|expected pay/, 'compensation'],
    [/gender|pronoun|veteran|military|race|disability|demographic/, 'demographics'],
    [/education|degree|school|start date|availability/, 'availability_education'],
    [/why|motivation|describe|project|narrative/, 'creative'],
    [/email|linkedin|github|portfolio|website|name|phone/, 'contact_profile'],
  ];
  return { family: rules.find(([pattern]) => pattern.test(text))?.[1] || 'unknown' };
}

export function isEvidenceCompatible(intent: FieldIntent, evidence: EvidenceDescriptor): boolean {
  if (evidence.kind === 'job_posting_location') return intent.family === 'workplace_preference';
  if (intent.family === 'residence' && evidence.kind.startsWith('job_')) return false;
  if (intent.family === 'employer_history' && /email|url/i.test(`${evidence.key || ''} ${String(evidence.value || '')}`)) return false;
  return true;
}

export function isAnswerableField(field: ScannedField): boolean {
  return field.classification !== 'system_widget';
}
