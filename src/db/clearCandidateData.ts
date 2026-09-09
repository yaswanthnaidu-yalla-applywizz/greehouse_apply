import fs from 'fs';
import path from 'path';
import { getDbClient, isSupabaseConfigured } from './client.js';

export async function clearCandidateData(candidateIds?: string[]) {
  console.log('🧹 [Wipe] Clearing candidate cache, answers, and applications...');

  // 1. Clear Local Cache Files
  const cacheDir = path.resolve(process.cwd(), 'cache', 'profiles');
  if (fs.existsSync(cacheDir)) {
    const files = fs.readdirSync(cacheDir);
    for (const file of files) {
      if (!candidateIds || candidateIds.some(id => file.includes(id))) {
        const filePath = path.join(cacheDir, file);
        fs.unlinkSync(filePath);
        console.log(`  🗑️ Removed local profile cache: ${file}`);
      }
    }
  }

  // 2. Clear Output Files
  const outputFiles = [
    'output/resolved_applications.json',
    'output/candidate_segments.json',
  ];
  for (const relPath of outputFiles) {
    const fullPath = path.resolve(process.cwd(), relPath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      console.log(`  🗑️ Removed output file: ${relPath}`);
    }
  }

  // 3. Clear Supabase Records
  if (isSupabaseConfigured()) {
    const client = getDbClient();

    if (candidateIds && candidateIds.length > 0) {
      console.log(`  🗑️ Removing Supabase data for candidates: ${candidateIds.join(', ')}...`);

      // Delete from candidate_qa_bank
      const { error: errQA, count: countQA } = await client
        .from('candidate_qa_bank')
        .delete({ count: 'exact' })
        .in('applywizz_id', candidateIds);
      if (errQA) console.warn(`  ⚠️ Error clearing candidate_qa_bank: ${errQA.message}`);
      else console.log(`  ✅ Cleared ${countQA ?? 0} answers from candidate_qa_bank`);

      // Delete from candidate_applications
      const { error: errApp, count: countApp } = await client
        .from('candidate_applications')
        .delete({ count: 'exact' })
        .in('applywizz_id', candidateIds);
      if (errApp) console.warn(`  ⚠️ Error clearing candidate_applications: ${errApp.message}`);
      else console.log(`  ✅ Cleared ${countApp ?? 0} applications from candidate_applications`);

      // Delete from candidate_resume_parsed
      const { error: errResume, count: countResume } = await client
        .from('candidate_resume_parsed')
        .delete({ count: 'exact' })
        .in('applywizz_id', candidateIds);
      if (errResume) console.warn(`  ⚠️ Error clearing candidate_resume_parsed: ${errResume.message}`);
      else console.log(`  ✅ Cleared ${countResume ?? 0} parsed resumes from candidate_resume_parsed`);

      // Delete profiles so they refetch fresh from ApplyWizz API
      const { error: errProf, count: countProf } = await client
        .from('profiles')
        .delete({ count: 'exact' })
        .in('applywizz_id', candidateIds);
      if (errProf) console.warn(`  ⚠️ Error clearing profiles: ${errProf.message}`);
      else console.log(`  ✅ Cleared ${countProf ?? 0} profiles from profiles table`);
    } else {
      console.log('  🗑️ Removing all answers, applications, and parsed resumes from Supabase...');
      // Clear all answers
      const { error: errQA, count: countQA } = await client
        .from('candidate_qa_bank')
        .delete({ count: 'exact' })
        .neq('applywizz_id', 'NON_EXISTENT');
      if (errQA) console.warn(`  ⚠️ Error clearing all candidate_qa_bank: ${errQA.message}`);
      console.log(`  ✅ Cleared ${countQA ?? 0} total answers from candidate_qa_bank`);

      // Clear all applications
      const { error: errApp, count: countApp } = await client
        .from('candidate_applications')
        .delete({ count: 'exact' })
        .neq('applywizz_id', 'NON_EXISTENT');
      if (errApp) console.warn(`  ⚠️ Error clearing all candidate_applications: ${errApp.message}`);
      console.log(`  ✅ Cleared ${countApp ?? 0} total applications from candidate_applications`);

      // Clear all parsed resumes
      const { error: errResume, count: countResume } = await client
        .from('candidate_resume_parsed')
        .delete({ count: 'exact' })
        .neq('applywizz_id', 'NON_EXISTENT');
      if (errResume) console.warn(`  ⚠️ Error clearing all candidate_resume_parsed: ${errResume.message}`);
      console.log(`  ✅ Cleared ${countResume ?? 0} total parsed resumes from candidate_resume_parsed`);
    }
  }

  console.log('✨ [Wipe] Clean slate ready!\n');
}

// Standalone execution
if (process.argv[1]?.includes('clearCandidateData')) {
  const targetIds = process.argv.slice(2);
  clearCandidateData(targetIds.length > 0 ? targetIds : undefined)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Wipe failed:', err);
      process.exit(1);
    });
}
