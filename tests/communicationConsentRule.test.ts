import { describe, it, expect } from 'vitest';
import { resolveStandardProfileAttribute } from '../src/resolver/tier1Supabase.js';
import type { ScannedField } from '../src/types/index.js';

describe('Communication & SMS Consent Rule', () => {
  it('resolves No to SMS / WhatsApp communication consent', () => {
    const field: ScannedField = {
      fieldId: 'q_sms',
      name: 'q_sms',
      type: 'select',
      label:
        'Would you like to receive communications via SMS and/or WhatsApp to the number provided [above or during the application process] about your application process? Message & data rates may apply and message frequency may vary. If you select no, we will only communicate with you via email and/or telephone calls. If you select yes and change your mind, you can always reply STOP to opt out.',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, {} as any);
    expect(res).toBe('No');
  });

  it('resolves false for checkbox SMS communication consent', () => {
    const field: ScannedField = {
      fieldId: 'q_sms_chk',
      name: 'q_sms_chk',
      type: 'checkbox',
      label: 'I consent to receive text messages via SMS about my job application status',
      isRequired: false,
    };
    const res = resolveStandardProfileAttribute(field, {} as any);
    expect(res).toBe('false');
  });
});
