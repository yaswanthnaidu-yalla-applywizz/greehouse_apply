import {
  isValidCsvUploadObjectName,
  MAX_CSV_UPLOAD_BYTES,
  parseCsvHeader,
  sanitizeCsvUploadFilename,
  selectCsvIngestionTarget,
  validateCsvUpload,
} from '../src/candidate/csvUploadValidation.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const oldCsv = 'Applywizz ID,Client Name,url,score\nAWL-123,Jane,https://boards.greenhouse.io/example,10';
const newCsv = 'company_job_url,applywizz_id,score,lead_name\nhttps://boards.greenhouse.io/example,AWL-123,10,Jane';

assert(validateCsvUpload(oldCsv).format === 'OLD', 'accepts the supported OLD CSV header');
assert(validateCsvUpload(newCsv).format === 'NEW', 'accepts the supported NEW CSV header');
assert(validateCsvUpload('\uFEFF"company_job_url","applywizz_id","score","lead_name"\n').valid, 'accepts BOM and quoted headers');
assert(!validateCsvUpload('name,email\nJane,jane@example.com').valid, 'rejects unsupported headers');
assert(!validateCsvUpload('').valid, 'rejects empty CSV files');
assert(parseCsvHeader('"job,url",applywizz_id,score,lead_name')[0] === 'job,url', 'parses quoted commas in headers');
assert(sanitizeCsvUploadFilename('C:\\uploads\\my jobs.csv') === 'my_jobs.csv', 'sanitizes Windows filenames');
assert(!isValidCsvUploadObjectName('../other.csv'), 'rejects path traversal targets');
assert(isValidCsvUploadObjectName('pending/550e8400-e29b-41d4-a716-446655440000_upload.csv'), 'accepts generated staged upload paths');
const pending = [{ name: '550e8400-e29b-41d4-a716-446655440001_other.csv', createdAt: null }];
assert(
  selectCsvIngestionTarget('pending/550e8400-e29b-41d4-a716-446655440000_upload.csv', pending)?.name
    === 'pending/550e8400-e29b-41d4-a716-446655440000_upload.csv',
  'explicit ingest never falls back to a different pending file'
);
assert(selectCsvIngestionTarget(undefined, pending)?.name === pending[0].name, 'unqualified ingest keeps latest-pending behavior');
assert(MAX_CSV_UPLOAD_BYTES === 25 * 1024 * 1024, 'enforces the documented upload cap');

console.log('CSV upload validation tests passed.');
