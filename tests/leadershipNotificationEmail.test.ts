import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveLeadershipRecipients,
  buildLeadershipInitialEmailHtml,
  buildLeadershipReminderEmailHtml,
  buildLeadershipCompletionEmailHtml,
  startLeadershipFollowupPoller,
  sendLeadershipIngestionSummary,
} from '../src/services/caNotificationEmail.js';

describe('leadership notification builders', () => {
  it('resolves production recipients when sandbox and override are disabled', () => {
    delete process.env.SANDBOX;
    delete process.env.CA_NOTIFICATION_EMAIL_OVERRIDE;
    const recipients = resolveLeadershipRecipients();
    assert.deepEqual(recipients.to, ['ramakrishnaa.tejavath@applywizz.ai', 'balaji@applywizz.ai']);
    assert.deepEqual(recipients.cc, [
      'anushabandreddy@applywizz.ai',
      'vivek@applywizz.ai',
      'yaswanthnaiduyalla@applywizz.ai',
    ]);
  });

  it('redirects to dev email and empties cc when sandbox mode is true', () => {
    process.env.SANDBOX = 'true';
    const recipients = resolveLeadershipRecipients();
    assert.deepEqual(recipients.to, ['yaswanthnaiduyalla@applywizz.ai']);
    assert.deepEqual(recipients.cc, []);
    delete process.env.SANDBOX;
  });

  it('redirects to override email and empties cc when CA_NOTIFICATION_EMAIL_OVERRIDE is set', () => {
    process.env.CA_NOTIFICATION_EMAIL_OVERRIDE = 'tester@applywizz.ai';
    const recipients = resolveLeadershipRecipients();
    assert.deepEqual(recipients.to, ['tester@applywizz.ai']);
    assert.deepEqual(recipients.cc, []);
    delete process.env.CA_NOTIFICATION_EMAIL_OVERRIDE;
  });

  it('builds initial email with counts and breakdown table', () => {
    const html = buildLeadershipInitialEmailHtml({
      totalTasks: 10,
      clientCount: 4,
      caCount: 2,
      perCa: [
        { caEmail: 'ca1@applywizz.ai', appCount: 6, clientCount: 2 },
        { caEmail: 'ca2@applywizz.ai', appCount: 4, clientCount: 2 },
      ],
    });
    assert.ok(html.includes('10 tasks for 4 clients across 2 CAs are ready for review'));
    assert.ok(html.includes('ca1@applywizz.ai'));
    assert.ok(html.includes('ca2@applywizz.ai'));
    assert.ok(html.includes('6'));
    assert.ok(html.includes('4'));
  });

  it('builds reminder email html with pending CAs and counts', () => {
    const reminderHtml = buildLeadershipReminderEmailHtml([
      { caEmail: 'ca1@applywizz.ai', remainingCount: 3 },
    ]);
    assert.ok(reminderHtml.includes('ca1@applywizz.ai'));
    assert.ok(reminderHtml.includes('3'));
    assert.ok(reminderHtml.includes('tasks remaining for review'));
  });

  it('builds completion congratulatory email html', () => {
    const completionHtml = buildLeadershipCompletionEmailHtml();
    assert.ok(completionHtml.includes('ALL TASKS COMPLETED'));
    assert.ok(completionHtml.includes('All tasks from today'));
  });
});

describe('startLeadershipFollowupPoller', () => {
  it('sends completion congratulatory email immediately if 0 tasks remain at first check', async () => {
    const sentEmails: any[] = [];
    const poller = startLeadershipFollowupPoller(['app-1', 'app-2'], {
      initialDelayMs: 10,
      dbQueryFn: async () => [],
      sendEmailFn: async (opts) => {
        sentEmails.push(opts);
        return { success: true };
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    poller.stop();
    assert.equal(sentEmails.length, 1);
    assert.ok(sentEmails[0].subject.includes('ALL TASKS COMPLETED'));
  });

  it('sends reminder email at first check and completion on second check', async () => {
    const sentEmails: any[] = [];
    let queryCount = 0;
    const poller = startLeadershipFollowupPoller(['app-1', 'app-2'], {
      initialDelayMs: 10,
      pollIntervalMs: 25,
      dbQueryFn: async () => {
        queryCount++;
        return queryCount === 1
          ? [{ id: 'app-1', assigned_ca_email: 'ca1@applywizz.ai' }]
          : [];
      },
      sendEmailFn: async (opts) => {
        sentEmails.push(opts);
        return { success: true };
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    poller.stop();
    assert.equal(sentEmails.length, 2);
    assert.ok(sentEmails[0].subject.includes('tasks remaining for review'));
    assert.ok(sentEmails[1].subject.includes('ALL TASKS COMPLETED'));
  });

  it('stops polling when two consecutive checks show the same remaining count (stall exit)', async () => {
    const sentEmails: any[] = [];
    let queryCount = 0;
    const poller = startLeadershipFollowupPoller(['app-1'], {
      initialDelayMs: 10,
      pollIntervalMs: 25,
      dbQueryFn: async () => {
        queryCount++;
        return [{ id: 'app-1', assigned_ca_email: 'ca1@applywizz.ai' }];
      },
      sendEmailFn: async (opts) => {
        sentEmails.push(opts);
        return { success: true };
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    poller.stop();
    // Exactly 1 reminder email sent (at initial check), subsequent check detected stall and terminated
    assert.equal(sentEmails.length, 1);
    assert.ok(queryCount >= 2);
  });
});

describe('sendLeadershipIngestionSummary', () => {
  it('handles empty / unconfigured runs gracefully without throwing', async () => {
    // When Supabase or Azure is unconfigured in test, it logs and exits cleanly
    await assert.doesNotReject(async () => {
      await sendLeadershipIngestionSummary(new Date());
    });
  });
});
