import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCandidateGmailEmail,
  isCandidateEligibleForZohoGate,
} from '../src/db/zohoConnected.js';
import type { ProfileRow } from '../src/db/profiles.js';

describe('Zoho Ingestion Gate & Gmail Filter', () => {
  it('detects consumer Gmail and Googlemail domains', () => {
    assert.equal(isCandidateGmailEmail('test@gmail.com'), true);
    assert.equal(isCandidateGmailEmail('TEST@GMAIL.COM'), true);
    assert.equal(isCandidateGmailEmail('user@googlemail.com'), true);
    assert.equal(isCandidateGmailEmail(' user@gmail.com '), true);

    // Non-gmail domains must return false
    assert.equal(isCandidateGmailEmail('user@applywizard.ai'), false);
    assert.equal(isCandidateGmailEmail('user@applywizz.ai'), false);
    assert.equal(isCandidateGmailEmail('user@company.com'), false);
    assert.equal(isCandidateGmailEmail(''), false);
    assert.equal(isCandidateGmailEmail(null), false);
    assert.equal(isCandidateGmailEmail(undefined), false);
  });

  it('rejects candidate if zoho_connected is false or missing', () => {
    const profileNoZoho: Partial<ProfileRow> = {
      applywizz_id: 'AWL-1',
      email: 'user@applywizard.ai',
      company_email: 'user@applywizard.ai',
      zoho_connected: false,
    };
    const res1 = isCandidateEligibleForZohoGate(profileNoZoho as ProfileRow);
    assert.equal(res1.eligible, false);
    assert.equal(res1.reason, 'zoho_not_connected');

    const profileUndefinedZoho: Partial<ProfileRow> = {
      applywizz_id: 'AWL-2',
      email: 'user@applywizard.ai',
      zoho_connected: undefined,
    };
    const res2 = isCandidateEligibleForZohoGate(profileUndefinedZoho as ProfileRow);
    assert.equal(res2.eligible, false);
    assert.equal(res2.reason, 'zoho_not_connected');
  });

  it('rejects candidate with Gmail address even if zoho_connected is true', () => {
    const profileGmail: Partial<ProfileRow> = {
      applywizz_id: 'AWL-3',
      email: 'john.doe@gmail.com',
      company_email: 'john.doe@gmail.com',
      zoho_connected: true,
    };
    const res = isCandidateEligibleForZohoGate(profileGmail as ProfileRow);
    assert.equal(res.eligible, false);
    assert.equal(res.reason, 'gmail_email_not_served');

    // Also if only personal email is gmail
    const profilePersonalGmail: Partial<ProfileRow> = {
      applywizz_id: 'AWL-4',
      email: 'john.doe@gmail.com',
      company_email: 'john.doe@applywizard.ai',
      zoho_connected: true,
    };
    const res2 = isCandidateEligibleForZohoGate(profilePersonalGmail as ProfileRow);
    assert.equal(res2.eligible, false);
    assert.equal(res2.reason, 'gmail_email_not_served');
  });

  it('allows candidate when zoho_connected is true and email is domain-based', () => {
    const validProfile: Partial<ProfileRow> = {
      applywizz_id: 'AWL-5',
      client_name: 'Verified User',
      email: 'verified.user@applywizard.ai',
      company_email: 'verified.user@applywizard.ai',
      zoho_connected: true,
    };
    const res = isCandidateEligibleForZohoGate(validProfile as ProfileRow);
    assert.equal(res.eligible, true);
    assert.equal(res.reason, undefined);
  });
});
