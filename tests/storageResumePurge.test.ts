import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { purgeResumesBucket, resumeStorageFilename } from '../src/db/storage.js';
import { setDbClient } from '../src/db/client.js';

describe('storage - purgeResumesBucket', () => {
  it('purges files from mock Supabase storage and local resumes folder', async () => {
    // Setup an isolated temporary directory for the test
    const tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-resumes-purge-'));
    const sampleLocalFile = path.join(tempTestDir, 'test_sample_purge_resume.pdf');
    fs.writeFileSync(sampleLocalFile, Buffer.from('test pdf content'));
    assert.equal(fs.existsSync(sampleLocalFile), true);

    const deletedBatches: string[][] = [];
    const mockDbClient = {
      storage: {
        from: (bucket: string) => {
          assert.equal(bucket, 'resumes');
          return {
            list: async () => ({
              data: [{ name: 'Resume_John_Doe.pdf' }, { name: 'Resume_Jane_Smith.pdf' }],
              error: null,
            }),
            remove: async (paths: string[]) => {
              deletedBatches.push(paths);
              return { data: paths, error: null };
            },
          };
        },
      },
    };

    setDbClient(mockDbClient as any);

    const result = await purgeResumesBucket({ resumesDir: tempTestDir });
    assert.equal(result.deletedCount, 2);
    assert.equal(result.clearedLocalCount, 1);
    assert.equal(deletedBatches.length, 1);
    assert.deepEqual(deletedBatches[0], ['Resume_John_Doe.pdf', 'Resume_Jane_Smith.pdf']);
    assert.equal(fs.existsSync(sampleLocalFile), false);

    // Clean up temp directory
    try {
      fs.rmdirSync(tempTestDir);
    } catch {}
  });

  it('updates resumeStorageFilename to produce Resume_FirstName_LastName.pdf', () => {
    const filename = resumeStorageFilename('AWL-12345', {
      firstName: 'Raj',
      lastName: 'Kumar',
    });
    assert.equal(filename, 'Resume_Raj_Kumar.pdf');
  });
});
