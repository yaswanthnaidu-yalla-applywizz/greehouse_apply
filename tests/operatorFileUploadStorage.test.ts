import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  sanitizeUploadFilename,
  uploadOperatorFieldFile,
  downloadOperatorFieldFile,
  syncUploadedResumeToProfile,
} from '../src/db/storage.js';

describe('operatorFileUpload - storage layer', () => {
  it('sanitizes unsafe upload filenames', () => {
    assert.equal(sanitizeUploadFilename('My Resume (2026).pdf'), 'My_Resume_2026.pdf');
    assert.equal(sanitizeUploadFilename('../../../etc/passwd.pdf'), 'passwd.pdf');
    assert.equal(sanitizeUploadFilename('weird*chars:<>|?"file.docx'), 'weird_chars_file.docx');
    assert.equal(sanitizeUploadFilename('   padded   .doc'), 'padded.doc');
  });

  it('uploads an operator field file and retrieves it', async () => {
    const applywizzId = 'AWL-TEST-999';
    const applicationId = 'app-unit-123';
    const fieldId = 'resume';
    const filename = 'Jane_Doe_Resume.pdf';
    const dummyBuffer = Buffer.from('%PDF-1.4 Mock PDF file content for operator upload test', 'utf-8');

    const result = await uploadOperatorFieldFile(
      applywizzId,
      applicationId,
      fieldId,
      filename,
      dummyBuffer,
      'application/pdf'
    );

    assert.ok(result.storagePath, 'Expected a non-empty storagePath');
    assert.ok(
      result.storagePath.includes('operator_uploads') && result.storagePath.includes(applywizzId),
      `Expected storage path to contain operator_uploads and applywizzId, got: ${result.storagePath}`
    );

    const downloadedBuffer = await downloadOperatorFieldFile(result.storagePath);
    assert.ok(downloadedBuffer, 'Expected downloaded buffer to exist');
    assert.equal(downloadedBuffer.toString('utf-8'), dummyBuffer.toString('utf-8'));
  });

  it('updates candidate profile resume_storage_path when resume uploaded', async () => {
    const applywizzId = 'AWL-TEST-SYNC';
    const storagePath = 'operator_uploads/AWL-TEST-SYNC/resume_test.pdf';

    let updatedTable = '';
    let updatedPayload: any = null;
    let matchedId = '';

    const mockDb = {
      from: (table: string) => {
        updatedTable = table;
        return {
          update: (payload: any) => {
            updatedPayload = payload;
            return {
              eq: (col: string, val: string) => {
                matchedId = val;
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      },
    };

    await syncUploadedResumeToProfile(applywizzId, storagePath, mockDb);
    assert.equal(updatedTable, 'profiles');
    assert.equal(matchedId, applywizzId);
    assert.equal(updatedPayload?.resume_storage_path, storagePath);
  });
});
