import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadResumeFromSupabaseStorage } from '../src/db/storage.js';

test('downloadResumeFromSupabaseStorage returns null when storagePath is empty or supabase not configured', async () => {
  const result = await downloadResumeFromSupabaseStorage('');
  assert.equal(result, null);
});
