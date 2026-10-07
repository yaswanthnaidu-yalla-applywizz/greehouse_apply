import { detectCsvFormat } from './segregator.js';

export const MAX_CSV_UPLOAD_BYTES = 25 * 1024 * 1024;

export function parseCsvHeader(csv: string): string[] {
  const input = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const headers: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (character === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      headers.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      break;
    } else {
      field += character;
    }
  }

  headers.push(field);
  return headers.map((header) => header.trim());
}

export function validateCsvUpload(csv: string): { valid: boolean; format: 'OLD' | 'NEW' | 'UNKNOWN' } {
  const header = parseCsvHeader(csv);
  const format = header.some((value) => value.length > 0) ? detectCsvFormat(header) : 'UNKNOWN';
  return { valid: format !== 'UNKNOWN', format };
}

export function sanitizeCsvUploadFilename(filename: string): string {
  const basename = filename.replace(/^.*[\\/]/, '').trim();
  if (!basename || !/\.csv$/i.test(basename)) {
    throw new Error('Please choose a CSV file.');
  }

  const safeName = basename
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(-120);
  if (!safeName || !/\.csv$/i.test(safeName)) {
    throw new Error('The CSV filename is invalid.');
  }
  return safeName;
}

export function isValidCsvUploadObjectName(name: string): boolean {
  return /^(?:pending\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[a-zA-Z0-9._-]+\.csv$/i.test(name);
}

export function selectCsvIngestionTarget<T extends { name: string; createdAt: string | null }>(
  explicitName: string | undefined,
  pendingFiles: T[]
): T | { name: string; createdAt: null } | null {
  if (explicitName !== undefined) {
    if (!isValidCsvUploadObjectName(explicitName)) {
      throw new Error('Invalid CSV upload object name.');
    }
    return { name: explicitName, createdAt: null };
  }
  return pendingFiles[0] || null;
}
