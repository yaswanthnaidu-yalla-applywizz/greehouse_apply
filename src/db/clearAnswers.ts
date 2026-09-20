/**
 * @fileoverview Script to clear resolved applications and historical answers
 * across local filesystem and Supabase tables (`candidate_applications`, `candidate_qa_bank`).
 *
 * Usage:
 *   npm run db:clear
 *   npm run db:clear -- --candidate=AWL-31428
 */

import fs from 'fs';
import path from 'path';
import { getDbClient, isSupabaseConfigured } from './client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Clear Answers');

async function clearData() {
  const args = process.argv.slice(2);
  const candidateArg = args.find((a) => a.startsWith('--candidate='));
  const candidateId = candidateArg ? candidateArg.split('=')[1]?.trim() : null;

  log.info('================================================================');
  log.info(`🧹 Clearing Resolved Answers & Applications`);
  if (candidateId) {
    log.info(`🎯 Target Candidate: ${candidateId}`);
  } else {
    log.info(`🎯 Target: ALL candidates`);
  }
  log.info('================================================================\n');

  // 1. Clear Supabase tables
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();

      // Clear candidate_applications
      let appQuery = supabase.from('gh_candidate_applications').delete();
      if (candidateId) {
        appQuery = appQuery.eq('applywizz_id', candidateId);
      } else {
        appQuery = appQuery.neq('id', '00000000-0000-0000-0000-000000000000');
      }
      const { error: appErr } = await appQuery;
      if (appErr) {
        log.warn(`⚠️ Supabase candidate_applications delete warning: ${appErr.message}`);
      } else {
        log.info('✅ Cleared Supabase table: candidate_applications');
      }

      // Clear candidate_qa_bank
      let qaQuery = supabase.from('gh_candidate_qa_bank').delete();
      if (candidateId) {
        qaQuery = qaQuery.eq('applywizz_id', candidateId);
      } else {
        qaQuery = qaQuery.neq('id', '00000000-0000-0000-0000-000000000000');
      }
      const { error: qaErr } = await qaQuery;
      if (qaErr) {
        log.warn(`⚠️ Supabase candidate_qa_bank delete warning: ${qaErr.message}`);
      } else {
        log.info('✅ Cleared Supabase table: candidate_qa_bank');
      }
    } catch (err: any) {
      log.warn(`⚠️ Supabase clear skipped or encountered error: ${err.message}`);
    }
  } else {
    log.info('ℹ️ Supabase not configured; skipping remote DB clear.');
  }

  // 2. Clear Local Output Files
  const resolvedPath = path.resolve(process.cwd(), 'output', 'resolved_applications.json');
  const segmentsPath = path.resolve(process.cwd(), 'output', 'candidate_segments.json');

  if (candidateId) {
    // Filter out target candidate in local files
    if (fs.existsSync(resolvedPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
        const filtered = Array.isArray(data)
          ? data.filter((item: any) => item.applywizzId !== candidateId && item.applywizz_id !== candidateId)
          : [];
        fs.writeFileSync(resolvedPath, JSON.stringify(filtered, null, 2));
        log.info(`✅ Removed candidate ${candidateId} from output/resolved_applications.json`);
      } catch {}
    }

    if (fs.existsSync(segmentsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(segmentsPath, 'utf-8'));
        const filtered = Array.isArray(data)
          ? data.filter((item: any) => item.applywizzId !== candidateId && item.applywizz_id !== candidateId)
          : [];
        fs.writeFileSync(segmentsPath, JSON.stringify(filtered, null, 2));
        log.info(`✅ Removed candidate ${candidateId} from output/candidate_segments.json`);
      } catch {}
    }
  } else {
    // Remove entire files
    if (fs.existsSync(resolvedPath)) {
      fs.unlinkSync(resolvedPath);
      log.info('✅ Deleted local file: output/resolved_applications.json');
    }
    if (fs.existsSync(segmentsPath)) {
      fs.unlinkSync(segmentsPath);
      log.info('✅ Deleted local file: output/candidate_segments.json');
    }
  }

  log.info('\n✨ Clear complete!\n');
}

clearData().catch((err) => {
  log.error('❌ Clear failed:', err);
  process.exit(1);
});
