import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveLeadershipRecipients,
  resolveExecutiveRecipients,
  groupReadyForReviewByManager,
  buildLeadershipInitialEmailHtml,
  buildLeadershipReminderEmailHtml,
  buildLeadershipCompletionEmailHtml,
  buildExecutiveInitialEmailHtml,
  buildExecutiveReminderEmailHtml,
  startLeadershipFollowupPoller,
  sendLeadershipIngestionSummary,
  KNOWN_MANAGERS,
} from '../src/services/caNotificationEmail.js';

describe('leadership and executive notification builders', () => {
  it('resolves production leadership recipients when sandbox and override are disabled', () => {
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

  it('resolves production executive recipients to Ramakrishna with CC as me and vivek', () => {
    delete process.env.SANDBOX;
    delete process.env.CA_NOTIFICATION_EMAIL_OVERRIDE;
    const recipients = resolveExecutiveRecipients();
    assert.deepEqual(recipients.to, ['ramakrishna@applywizz.ai']);
    assert.deepEqual(recipients.cc, [
      'yaswanthnaiduyalla@applywizz.ai',
      'vivek@applywizz.ai',
    ]);
  });

  it('redirects executive recipients to dev email and empties cc when sandbox mode is true', () => {
    process.env.SANDBOX = 'true';
    const recipients = resolveExecutiveRecipients();
    assert.deepEqual(recipients.to, ['yaswanthnaiduyalla@applywizz.ai']);
    assert.deepEqual(recipients.cc, []);
    delete process.env.SANDBOX;
  });

  it('redirects executive recipients to override email and empties cc when CA_NOTIFICATION_EMAIL_OVERRIDE is set', () => {
    process.env.CA_NOTIFICATION_EMAIL_OVERRIDE = 'tester@applywizz.ai';
    const recipients = resolveExecutiveRecipients();
    assert.deepEqual(recipients.to, ['tester@applywizz.ai']);
    assert.deepEqual(recipients.cc, []);
    delete process.env.CA_NOTIFICATION_EMAIL_OVERRIDE;
  });

  it('groups ready-for-review apps by manager and includes both known managers even with 0 tasks', () => {
    const caMap = new Map<string, string>([
      ['ca1@applywizz.ai', 'balaji@applywizz.ai'],
      ['ca2@applywizz.ai', 'balaji@applywizz.ai'],
    ]);
    const rows = [
      { applywizz_id: 'AWL-1', assigned_ca_email: 'ca1@applywizz.ai', job_url: 'https://example.com/1' },
      { applywizz_id: 'AWL-2', assigned_ca_email: 'ca2@applywizz.ai', job_url: 'https://example.com/2' },
      { applywizz_id: 'AWL-1', assigned_ca_email: 'ca1@applywizz.ai', job_url: 'https://example.com/3' },
    ];
    const summaries = groupReadyForReviewByManager(rows, caMap);
    assert.equal(summaries.length, 2);

    const balaji = summaries.find((s) => s.managerEmail === 'balaji@applywizz.ai');
    assert.ok(balaji);
    assert.equal(balaji.appCount, 3);
    assert.equal(balaji.clientCount, 2);
    assert.equal(balaji.managerName, 'Balaji');

    const rk = summaries.find((s) => s.managerEmail === 'ramakrishnaa.tejavath@applywizz.ai');
    assert.ok(rk);
    assert.equal(rk.appCount, 0);
    assert.equal(rk.clientCount, 0);
    assert.equal(rk.managerName, 'Ramakrishna Tejavath');
  });

  it('builds executive initial email with "x manager has y number of tasks to be done" info for both managers', () => {
    const html = buildExecutiveInitialEmailHtml({
      totalTasks: 15,
      clientCount: 5,
      managers: [
        { managerEmail: 'balaji@applywizz.ai', managerName: 'Balaji', appCount: 10, clientCount: 3 },
        { managerEmail: 'ramakrishnaa.tejavath@applywizz.ai', managerName: 'Ramakrishna Tejavath', appCount: 5, clientCount: 2 },
      ],
    });
    assert.ok(html.includes('<strong>Balaji</strong> has <strong>10</strong> number of tasks to be done'));
    assert.ok(html.includes('<strong>Ramakrishna Tejavath</strong> has <strong>5</strong> number of tasks to be done'));
    assert.ok(html.includes('Follow-up status check scheduled in 1 hour.'));
  });

  it('builds executive reminder email with remaining tasks info for both managers', () => {
    const html = buildExecutiveReminderEmailHtml([
      { managerEmail: 'balaji@applywizz.ai', managerName: 'Balaji', remainingCount: 4 },
      { managerEmail: 'ramakrishnaa.tejavath@applywizz.ai', managerName: 'Ramakrishna Tejavath', remainingCount: 2 },
    ]);
    assert.ok(html.includes('<strong>Balaji</strong> has <strong>4</strong> remaining tasks to be done'));
    assert.ok(html.includes('<strong>Ramakrishna Tejavath</strong> has <strong>2</strong> remaining tasks to be done'));
    assert.ok(html.includes('1 hour has elapsed since ingestion.'));
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
    assert.ok(html.includes('Follow-up status check scheduled in 1 hour.'));
  });

  it('builds reminder email html with pending CAs and counts', () => {
    const reminderHtml = buildLeadershipReminderEmailHtml([
      { caEmail: 'ca1@applywizz.ai', remainingCount: 3 },
    ]);
    assert.ok(reminderHtml.includes('ca1@applywizz.ai'));
    assert.ok(reminderHtml.includes('3'));
    assert.ok(reminderHtml.includes('tasks remaining for review'));
    assert.ok(reminderHtml.includes('1 hour has elapsed since ingestion.'));
  });

  it('builds completion congratulatory email html', () => {
    const completionHtml = buildLeadershipCompletionEmailHtml();
    assert.ok(completionHtml.includes('ALL TASKS COMPLETED'));
    assert.ok(completionHtml.includes('All tasks from today'));
  });
});

describe('startLeadershipFollowupPoller', () => {
  it('sends completion congratulatory email to both Leadership and Executive if 0 tasks remain at first check', async () => {
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
    assert.equal(sentEmails.length, 2);
    assert.ok(sentEmails[0].subject.includes('ALL TASKS COMPLETED'));
    assert.ok(sentEmails[1].subject.includes('ALL TASKS COMPLETED'));
    // First goes to leadership, second goes to executive (Ramakrishna)
    assert.deepEqual(sentEmails[1].to, ['ramakrishna@applywizz.ai']);
    assert.deepEqual(sentEmails[1].cc, ['yaswanthnaiduyalla@applywizz.ai', 'vivek@applywizz.ai']);
  });

  it('sends reminder emails to both Leadership and Executive at first check and completion on second check', async () => {
    const sentEmails: any[] = [];
    let queryCount = 0;
    const caMap = new Map<string, string>([['ca1@applywizz.ai', 'balaji@applywizz.ai']]);

    const poller = startLeadershipFollowupPoller(['app-1', 'app-2'], {
      initialDelayMs: 10,
      pollIntervalMs: 25,
      caToManagerMapFn: async () => caMap,
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

    // Check 1: 1 email to Leadership + 1 email to Executive (Ramakrishna)
    // Check 2: 1 completion email to Leadership + 1 completion email to Executive (Ramakrishna)
    assert.equal(sentEmails.length, 4);
    assert.ok(sentEmails[0].subject.includes('tasks remaining for review'));
    assert.ok(sentEmails[1].subject.includes('tasks remaining across managers'));
    assert.deepEqual(sentEmails[1].to, ['ramakrishna@applywizz.ai']);
    assert.ok(sentEmails[1].html.includes('<strong>Balaji</strong> has <strong>1</strong> remaining tasks to be done'));

    assert.ok(sentEmails[2].subject.includes('ALL TASKS COMPLETED'));
    assert.ok(sentEmails[3].subject.includes('ALL TASKS COMPLETED'));
  });

  it('does NOT dispatch completion email if database query fails with an error (prevents congratulatory misfire)', async () => {
    const sentEmails: any[] = [];
    let queryCount = 0;
    const poller = startLeadershipFollowupPoller(['app-1', 'app-2'], {
      initialDelayMs: 10,
      pollIntervalMs: 25,
      dbQueryFn: async () => {
        queryCount++;
        throw new Error('Supabase PostgREST 414 Request-URI Too Large');
      },
      sendEmailFn: async (opts) => {
        sentEmails.push(opts);
        return { success: true };
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    poller.stop();

    // Zero congratulatory emails should be sent when the query fails!
    assert.equal(sentEmails.length, 0);
    assert.ok(queryCount >= 2);
  });

  it('stops polling when two consecutive checks show the same remaining count (stall exit)', async () => {
    const sentEmails: any[] = [];
    let queryCount = 0;
    const caMap = new Map<string, string>([['ca1@applywizz.ai', 'balaji@applywizz.ai']]);
    const poller = startLeadershipFollowupPoller(['app-1'], {
      initialDelayMs: 10,
      pollIntervalMs: 25,
      caToManagerMap: caMap,
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
    // 2 reminder emails sent at initial check (Leadership + Executive), then subsequent check detected stall and terminated
    assert.equal(sentEmails.length, 2);
    assert.ok(queryCount >= 2);
  });
});

describe('sendLeadershipIngestionSummary', () => {
  it('handles empty / unconfigured runs gracefully without throwing', async () => {
    await assert.doesNotReject(async () => {
      await sendLeadershipIngestionSummary(new Date());
    });
  });
});
