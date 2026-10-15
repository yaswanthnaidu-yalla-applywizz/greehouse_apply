import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

import { resolveStandardProfileAttribute } from '../src/resolver/tier1Supabase.js';
import { applyEducationFieldFallbacks } from '../src/submitter/formFiller.js';

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
  console.log('Fetching 28 Glean and Moloco applications...');
  const { data: apps, error: fetchErr } = await supabase
    .from('gh_candidate_applications')
    .select('id, applywizz_id, company_name, job_title, resolved_fields, status')
    .in('company_name', ['Glean', 'Moloco'])
    .in('status', ['QUEUED', 'FAILED']);

  if (fetchErr) {
    console.error('Fetch error:', fetchErr);
    process.exit(1);
  }

  console.log(`Found ${apps.length} applications.`);

  // Fetch unique profiles for these candidates
  const applywizzIds = Array.from(new Set(apps.map(a => a.applywizz_id)));
  const { data: profiles, error: profErr } = await supabase
    .from('profiles')
    .select('*')
    .in('applywizz_id', applywizzIds);

  if (profErr) {
    console.error('Profiles fetch error:', profErr);
    process.exit(1);
  }

  const profileMap = new Map<string, any>();
  for (const p of profiles || []) {
    profileMap.set(p.applywizz_id, p);
  }

  let updatedCount = 0;

  for (const app of apps) {
    const profile = profileMap.get(app.applywizz_id);
    if (!profile) {
      console.warn(`Profile not found for candidate ${app.applywizz_id}`);
      continue;
    }

    const currentFields = (app.resolved_fields || []) as any[];

    // 1. Re-resolve standard attributes using the updated Tier 1 logic
    const refreshedFields = currentFields.map((f: any) => {
      // If field is discipline / major
      if (/\bdiscipline\b|major|field of study/i.test(`${f.fieldId} ${f.label} ${f.name || ''}`)) {
        const standardMajor = resolveStandardProfileAttribute(
          {
            fieldId: f.fieldId,
            name: f.name || f.fieldId,
            label: f.label,
            type: f.type,
            options: f.options,
            isRequired: f.isRequired,
          } as any,
          profile
        );

        const finalDiscipline = standardMajor && standardMajor.trim() ? standardMajor : 'Computer Science';
        return {
          ...f,
          value: finalDiscipline,
          source: 'supabase',
          resolvedByTier: 1,
        };
      }
      return f;
    });

    // 2. Apply formFiller's education field fallbacks (year clamping to 2018/2022 and discipline)
    const normalizedFields = applyEducationFieldFallbacks(refreshedFields, true);

    const discipline = normalizedFields.find((f: any) => /\bdiscipline\b|major/i.test(`${f.fieldId} ${f.label}`));
    const startYear = normalizedFields.find((f: any) => /start.*year/i.test(`${f.fieldId} ${f.label}`));
    const endYear = normalizedFields.find((f: any) => /end.*year/i.test(`${f.fieldId} ${f.label}`));
    const location = normalizedFields.find((f: any) => /location/i.test(`${f.fieldId} ${f.label}`));

    console.log(`\nCandidate ${app.applywizz_id} (${app.company_name} - ${app.job_title}):`);
    if (discipline) console.log(`  Discipline: "${discipline.value}"`);
    if (startYear) console.log(`  Start Year: "${startYear.value}"`);
    if (endYear) console.log(`  End Year: "${endYear.value}"`);
    if (location) console.log(`  Location: "${location.value}"`);

    // 3. Update the database row with newly normalized & resolved fields
    const { error: updateErr } = await supabase
      .from('gh_candidate_applications')
      .update({
        resolved_fields: normalizedFields,
        status: 'QUEUED',
        error_message: null,
        proof_failed_url: null,
        proof_failed_captured_at: null,
      })
      .eq('id', app.id);

    if (updateErr) {
      console.error(`Failed to update application ${app.id}:`, updateErr);
    } else {
      updatedCount++;
    }
  }

  console.log(`\n✅ Finished: Successfully refreshed and replaced resolved_fields for ${updatedCount}/${apps.length} applications in remote DB2.`);
}

run().catch(console.error);
