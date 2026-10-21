/**
 * One-off diagnostic: compare candidate_applications.resolved_fields vs scanned_job_templates.fields_schema
 */
import 'dotenv/config';
import { getDbClient, isSupabaseConfigured } from '../src/db/client.js';
import { findTemplateByJobUrl } from '../src/db/templates.js';
import { hydrateApplicationResolvedFields } from '../src/db/applicationFieldHydration.js';

async function main(): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.error('Supabase not configured (.env missing SUPABASE_URL / keys)');
    process.exit(1);
  }
  const sb = getDbClient();

  const { data: apps, error: e1 } = await sb
    .from('candidate_applications')
    .select('id, applywizz_id, job_url, status, resolved_fields')
    .order('updated_at', { ascending: false })
    .limit(20);

  if (e1) {
    console.error('candidate_applications query failed:', e1.message);
    process.exit(1);
  }

  console.log('=== candidate_applications (recent, resolved_fields length) ===');
  for (const a of apps || []) {
    const rf = a.resolved_fields;
    const len = Array.isArray(rf) ? rf.length : rf == null ? 'null' : 'non-array';
    console.log(
      JSON.stringify({
        applywizz_id: a.applywizz_id,
        job_url: a.job_url,
        status: a.status,
        resolved_fields_len: len,
      })
    );
  }

  const emptyApps = (apps || []).filter(
    (a) => !Array.isArray(a.resolved_fields) || a.resolved_fields.length === 0
  );

  console.log(`\n=== empty resolved_fields in sample: ${emptyApps.length}/${apps?.length ?? 0} ===`);

  for (const app of emptyApps.slice(0, 5)) {
    const url = app.job_url as string;
    console.log('\n--- chain check for empty resolved_fields application ---');
    console.log('application:', { applywizz_id: app.applywizz_id, job_url: url });

    const { data: tplExact } = await sb
      .from('scanned_job_templates')
      .select('job_url, field_count, fields_schema, company_name, job_title, is_expired')
      .eq('job_url', url)
      .maybeSingle();
    console.log('DB exact template match:', tplExact ? { job_url: tplExact.job_url, field_count: tplExact.field_count } : null);

    const tplFuzzy = await findTemplateByJobUrl(url);
    console.log('findTemplateByJobUrl:', tplFuzzy ? { job_url: tplFuzzy.job_url, fields_schema_len: tplFuzzy.fields_schema?.length } : null);

    const hydrated = await hydrateApplicationResolvedFields(app as any);
    console.log('hydrateApplicationResolvedFields:', {
      hydratedFromTemplate: hydrated.hydratedFromTemplate,
      resolved_fields_len: hydrated.application.resolved_fields?.length ?? 0,
    });
  }

  const { count: totalApps } = await sb
    .from('candidate_applications')
    .select('*', { count: 'exact', head: true });

  const { data: allAppsMini } = await sb.from('candidate_applications').select('resolved_fields');
  let emptyTotal = 0;
  for (const row of allAppsMini || []) {
    if (!Array.isArray(row.resolved_fields) || row.resolved_fields.length === 0) emptyTotal++;
  }

  const { count: templateCount } = await sb
    .from('scanned_job_templates')
    .select('*', { count: 'exact', head: true });

  const { data: zeroFieldTemplates } = await sb
    .from('scanned_job_templates')
    .select('job_url, field_count')
    .eq('field_count', 0)
    .limit(10);

  console.log('\n=== aggregate ===');
  console.log({
    totalApplications: totalApps,
    applicationsWithEmptyResolvedFields: emptyTotal,
    totalTemplates: templateCount,
    templatesWithZeroFieldCountSample: zeroFieldTemplates?.length ?? 0,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
