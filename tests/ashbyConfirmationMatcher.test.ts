import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchAshbyConfirmationEmail,
  isAshbySenderCandidate,
  ASHBY_CONFIRMATION_CLOCK_SKEW_MS,
  ASHBY_REJECTION_PATTERNS,
  ASHBY_CONFIRMATION_PATTERNS,
  type AshbyConfirmationMessage,
  type AshbyConfirmationContext,
} from '../src/services/inbox/ashbyConfirmationMatcher.js';
import {
  ashbyPositiveFixtures,
  ashbyRejectionFixtures,
} from './fixtures/ashbyConfirmationEmails.js';

describe('Ashby Confirmation Email Matcher', () => {
  it('exports clock skew and regex suites', () => {
    assert.equal(ASHBY_CONFIRMATION_CLOCK_SKEW_MS, 5_000);
    assert.ok(Array.isArray(ASHBY_REJECTION_PATTERNS) && ASHBY_REJECTION_PATTERNS.length >= 7);
    assert.ok(Array.isArray(ASHBY_CONFIRMATION_PATTERNS) && ASHBY_CONFIRMATION_PATTERNS.length >= 7);
  });

  describe('Positive Corpus Fixtures', () => {
    it('matches all 8 positive corpus fixtures', () => {
      assert.equal(ashbyPositiveFixtures.length, 8);
      for (const fixture of ashbyPositiveFixtures) {
        const result = matchAshbyConfirmationEmail(fixture.message, fixture.context);
        assert.equal(
          result.matched,
          true,
          `Expected fixture "${fixture.name}" to match, got: ${JSON.stringify(result)}`
        );
        assert.equal(result.reason, 'matched');
      }
    });

    it('matches Replit fixture with conditional clause as confirmation without false rejection', () => {
      const replit = ashbyPositiveFixtures.find((f) => f.name === 'Replit');
      assert.ok(replit, 'Replit fixture should exist');
      assert.ok(
        replit.message.bodyText.includes('If you are not selected for this position'),
        'Replit fixture must include conditional clause'
      );
      const result = matchAshbyConfirmationEmail(replit.message, replit.context);
      assert.equal(result.matched, true);
      assert.equal(result.reason, 'matched');
    });
  });

  describe('Rejection Corpus Fixtures (Fail-Closed)', () => {
    it('rejects all 5 adverse corpus fixtures with reason "rejection"', () => {
      assert.equal(ashbyRejectionFixtures.length, 5);
      const reasons = ashbyRejectionFixtures.map(({ message, context, name }) => {
        const res = matchAshbyConfirmationEmail(message, context);
        assert.equal(
          res.matched,
          false,
          `Expected adverse fixture "${name}" not to match, got: ${JSON.stringify(res)}`
        );
        return res.reason;
      });

      assert.deepEqual(reasons, [
        'rejection',
        'rejection',
        'rejection',
        'rejection',
        'rejection',
      ]);
    });
  });

  describe('Header and Context Guards', () => {
    const baseContext: AshbyConfirmationContext = {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'Nexxen',
      jobTitle: 'Senior Machine Learning Engineer',
    };

    const validMessage: AshbyConfirmationMessage = {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Thank You for Applying to Nexxen!',
      bodyText:
        'Thank you for your interest in Nexxen! We received your application for the Senior Machine Learning Engineer role.',
    };

    it('rejects when recipient email does not match candidate email', () => {
      const wrongRecipientMsg: AshbyConfirmationMessage = {
        ...validMessage,
        to: 'different.candidate@applywizard.ai',
      };
      const result = matchAshbyConfirmationEmail(wrongRecipientMsg, baseContext);
      assert.equal(result.matched, false);
      assert.equal(result.reason, 'recipient_mismatch');
    });

    it('handles angle-bracket wrapped recipient addresses gracefully', () => {
      const bracketMsg: AshbyConfirmationMessage = {
        ...validMessage,
        to: 'Candidate Name <candidate@applywizard.ai>',
      };
      const result = matchAshbyConfirmationEmail(bracketMsg, baseContext);
      assert.equal(result.matched, true);
      assert.equal(result.reason, 'matched');
    });

    it('rejects unrelated sender with sender_mismatch', () => {
      const unrelatedSenderMsg: AshbyConfirmationMessage = {
        ...validMessage,
        from: 'recruiter@randomfirm.com',
      };
      const result = matchAshbyConfirmationEmail(unrelatedSenderMsg, baseContext);
      assert.equal(result.matched, false);
      assert.equal(result.reason, 'sender_mismatch');
    });

    it('rejects company mismatch when company does not appear in subject or body', () => {
      const wrongCompanyMsg: AshbyConfirmationMessage = {
        from: 'no-reply@ashbyhq.com',
        to: 'candidate@applywizard.ai',
        subject: 'Thank You for Applying to AcmeCorp!',
        bodyText:
          'Thank you for your interest in AcmeCorp! We received your application for the role.',
      };
      const result = matchAshbyConfirmationEmail(wrongCompanyMsg, baseContext);
      assert.equal(result.matched, false);
      assert.equal(result.reason, 'company_mismatch');
    });

    it('handles custom vanity sender (Keycard): matches for Keycard, fails for other company', () => {
      const keycardSenderMsg: AshbyConfirmationMessage = {
        from: 'no-reply@keycard.ai',
        to: 'candidate@applywizard.ai',
        subject: 'Thanks for applying to Keycard!',
        bodyText:
          'Thank you for applying for the role at Keycard! We received your application.',
      };
      const keycardContext: AshbyConfirmationContext = {
        candidateEmail: 'candidate@applywizard.ai',
        companyName: 'Keycard',
      };
      const otherCompanyContext: AshbyConfirmationContext = {
        candidateEmail: 'candidate@applywizard.ai',
        companyName: 'OtherCorp',
      };

      const matchKeycard = matchAshbyConfirmationEmail(keycardSenderMsg, keycardContext);
      assert.equal(matchKeycard.matched, true);
      assert.equal(matchKeycard.reason, 'matched');

      const matchOther = matchAshbyConfirmationEmail(keycardSenderMsg, otherCompanyContext);
      assert.equal(matchOther.matched, false);
      assert.ok(
        matchOther.reason === 'sender_mismatch' || matchOther.reason === 'company_mismatch',
        `Expected sender_mismatch or company_mismatch, got: ${matchOther.reason}`
      );
    });

    it('returns missing_success_signal when email has no positive receipt patterns and no rejection', () => {
      const neutralMsg: AshbyConfirmationMessage = {
        from: 'no-reply@ashbyhq.com',
        to: 'candidate@applywizard.ai',
        subject: 'Nexxen Inquiry Update',
        bodyText:
          'Hello, regarding your inquiry about Nexxen office hours, our team will be available next week.',
      };
      const result = matchAshbyConfirmationEmail(neutralMsg, baseContext);
      assert.equal(result.matched, false);
      assert.equal(result.reason, 'missing_success_signal');
    });
  });

  describe('isAshbySenderCandidate', () => {
    it('accepts standard Ashby outbound senders', () => {
      assert.equal(isAshbySenderCandidate('no-reply@ashbyhq.com', 'Nexxen'), true);
      assert.equal(isAshbySenderCandidate('hiring@ashbyhq.com', 'Ashby'), true);
      assert.equal(isAshbySenderCandidate('Ashby <no-reply@ashbyhq.com>', 'Orchard'), true);
    });

    it('accepts valid custom employer vanity domain matching company name', () => {
      assert.equal(isAshbySenderCandidate('no-reply@keycard.ai', 'Keycard'), true);
      assert.equal(isAshbySenderCandidate('recruiting@thezebra.com', 'The Zebra'), true);
    });

    it('rejects custom vanity domain when company does not match domain', () => {
      assert.equal(isAshbySenderCandidate('no-reply@keycard.ai', 'Google'), false);
    });

    it('rejects arbitrary generic or unrelated sender addresses', () => {
      assert.equal(isAshbySenderCandidate('recruiter@randomfirm.com', 'Keycard'), false);
      assert.equal(isAshbySenderCandidate('spammer@gmail.com', 'Nexxen'), false);
      assert.equal(isAshbySenderCandidate('', 'Nexxen'), false);
    });
  });
});
