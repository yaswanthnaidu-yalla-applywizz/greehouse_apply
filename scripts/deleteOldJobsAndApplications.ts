import { getDbClient, isSupabaseConfigured } from '../src/db/client.js';

const ALL_ROWS_FILTER = '00000000-0000-0000-0000-000000000000';

async function deleteOldJobsAndApplications(): Promise<void> {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  }

  const supabase = getDbClient();

  const { error: jobsError } = await supabase
    .from('scanned_job_templates')
    .delete()
    .neq('id', ALL_ROWS_FILTER);
  if (jobsError) {
    throw new Error(`Failed to delete scanned_job_templates: ${jobsError.message}`);
  }
  console.log('✅ Deleted all scanned_job_templates');

  const { error: applicationsError } = await supabase
    .from('candidate_applications')
    .delete()
    .neq('id', ALL_ROWS_FILTER);
  if (applicationsError) {
    throw new Error(`Failed to delete candidate_applications: ${applicationsError.message}`);
  }
  console.log('✅ Deleted all candidate_applications');
}

deleteOldJobsAndApplications().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ Failed to delete old jobs and applications: ${message}`);
  process.exitCode = 1;
});
