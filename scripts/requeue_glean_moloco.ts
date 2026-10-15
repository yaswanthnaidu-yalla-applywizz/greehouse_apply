import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rrqsqakctbrhqcoqavoj.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

async function run() {
  console.log('Querying FAILED applications for Glean and Moloco...');
  const { data: apps, error: fetchErr } = await supabase
    .from('gh_candidate_applications')
    .select('id, applywizz_id, company_name, job_title, status, retry_count')
    .in('company_name', ['Glean', 'Moloco'])
    .eq('status', 'FAILED');

  if (fetchErr) {
    console.error('Fetch error:', fetchErr);
    process.exit(1);
  }

  console.log(`Found ${apps.length} applications to re-queue (Glean/Moloco FAILED).`);
  for (const app of apps) {
    console.log(` - ${app.company_name} | ${app.applywizz_id} | ${app.job_title} (current retries: ${app.retry_count})`);
  }

  const appIds = apps.map(a => a.id);
  if (appIds.length === 0) {
    console.log('No applications to update.');
    return;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('gh_candidate_applications')
    .update({
      status: 'QUEUED',
      error_message: null,
      proof_failed_url: null,
      proof_failed_captured_at: null,
    })
    .in('id', appIds)
    .select('id, status');

  if (updateErr) {
    console.error('Update error:', updateErr);
    process.exit(1);
  }

  console.log(`Successfully transitioned ${updated.length} applications to QUEUED.`);
}

run().catch(console.error);
