import 'dotenv/config';
import { getDbClient, isSupabaseConfigured } from '../src/db/client.js';

async function main(): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.log('Supabase not configured');
    process.exit(1);
  }
  const sb = getDbClient();

  const { data: skippedRows, error: selErr } = await sb
    .from('candidate_applications')
    .select('id, applywizz_id, job_url, status')
    .eq('status', 'SKIPPED')
    .limit(5);

  console.log(
    JSON.stringify(
      {
        existingSkippedRows: skippedRows?.length ?? 0,
        sample: skippedRows ?? [],
        selectError: selErr?.message ?? null,
      },
      null,
      2
    )
  );

  const { data: profile } = await sb.from('profiles').select('applywizz_id').limit(1).maybeSingle();
  const awl = profile?.applywizz_id;
  if (!awl) {
    console.log(JSON.stringify({ migration014Applied: 'unknown', reason: 'no profiles row for probe' }));
    process.exit(0);
  }

  const probeUrl = 'https://migration-probe.local/014-skipped-status-check';
  const { data: inserted, error: insErr } = await sb
    .from('candidate_applications')
    .upsert(
      {
        applywizz_id: awl,
        job_url: probeUrl,
        status: 'SKIPPED',
        resolved_fields: [],
        company_name: 'migration-probe',
        job_title: 'probe',
        error_message: 'migration 014 probe — safe to delete',
      },
      { onConflict: 'applywizz_id,job_url' }
    )
    .select('id, status')
    .single();

  if (insErr) {
    const msg = insErr.message || String(insErr);
    const checkViolation = /check constraint|violates check|candidate_applications_status_check/i.test(msg);
    console.log(
      JSON.stringify(
        {
          migration014Applied: checkViolation ? false : 'unknown',
          probeUpsert: 'failed',
          error: msg,
        },
        null,
        2
      )
    );
    process.exit(checkViolation ? 2 : 1);
  }

  console.log(JSON.stringify({ probeUpsert: 'ok', inserted }, null, 2));
  await sb.from('candidate_applications').delete().eq('job_url', probeUrl);
  console.log(JSON.stringify({ migration014Applied: true, probeRowDeleted: true }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
