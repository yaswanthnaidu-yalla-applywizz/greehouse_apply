import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getApplication } from '../src/db/applications.js';

describe('V1 Artifact Purge & Fallbacks', () => {
  const dummyDir = path.resolve(process.cwd(), 'output');
  const dummyFile = path.resolve(dummyDir, 'resolved_applications.json');
  let existed = false;
  let originalContent = '';

  beforeEach(() => {
    if (fs.existsSync(dummyFile)) {
      existed = true;
      originalContent = fs.readFileSync(dummyFile, 'utf8');
    } else {
      if (!fs.existsSync(dummyDir)) fs.mkdirSync(dummyDir, { recursive: true });
    }
    // Write a dummy V1 file containing an app not in DB or memory
    const dummyApps = [
      {
        applywizzId: 'AWL-V1-DUMMY',
        jobUrl: 'https://boards.greenhouse.io/v1test/jobs/12345',
        companyName: 'V1 Dummy Corp',
        jobTitle: 'Ghost Role',
        status: 'READY_FOR_REVIEW',
        resolvedFields: []
      }
    ];
    fs.writeFileSync(dummyFile, JSON.stringify(dummyApps));
  });

  afterEach(() => {
    if (existed) {
      fs.writeFileSync(dummyFile, originalContent);
    } else if (fs.existsSync(dummyFile)) {
      fs.unlinkSync(dummyFile);
    }
  });

  it('getApplication does not resurrect records from output/resolved_applications.json', async () => {
    const result = await getApplication('AWL-V1-DUMMY');
    // Must be null because V2 does not read disk fallback
    expect(result).toBeNull();
  });
});
