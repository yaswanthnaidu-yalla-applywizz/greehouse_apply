import fs from 'fs';
import path from 'path';
import { downloadProofBuffer } from '../src/db/storage.js';

const testId = `${process.pid}-${Date.now()}`;
const cases = [
  { bucket: 'proofs_web', directory: 'proofs', objectPath: `proofs/web-proof-${testId}.png` },
  { bucket: 'proofs_failed', directory: 'proofs_failed', objectPath: `failed-proof-${testId}.png` },
  { bucket: 'proofs_mail', directory: 'proofs_mail', objectPath: `mail-proof-${testId}.png` },
  { bucket: 'proofs_dry_run', directory: 'proofs_dry_run', objectPath: `dry-run/dryrun-proof-${testId}.png` },
];
const previousForceMemoryDb = process.env.FORCE_MEMORY_DB;
const fixturePaths = cases.map(({ directory, objectPath }) =>
  path.resolve(process.cwd(), 'output', directory, path.basename(objectPath))
);

async function run(): Promise<void> {
  process.env.FORCE_MEMORY_DB = 'true';
  try {
    for (let index = 0; index < cases.length; index++) {
      const testCase = cases[index];
      const fixturePath = fixturePaths[index];
      fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
      const expected = Buffer.from(`proof fixture ${testCase.bucket}`);
      fs.writeFileSync(fixturePath, expected);

      const actual = await downloadProofBuffer(testCase.bucket, testCase.objectPath);
      if (!actual?.equals(expected)) {
        throw new Error(`Local proof fallback failed for bucket ${testCase.bucket}`);
      }
    }
  } finally {
    for (const fixturePath of fixturePaths) {
      if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath);
      const directory = path.dirname(fixturePath);
      try {
        fs.rmdirSync(directory);
      } catch {
        // Keep non-empty output directories intact.
      }
    }
    if (previousForceMemoryDb === undefined) {
      delete process.env.FORCE_MEMORY_DB;
    } else {
      process.env.FORCE_MEMORY_DB = previousForceMemoryDb;
    }
  }
}

run()
  .then(() => console.log('Proof storage local fallback tests passed.'))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
