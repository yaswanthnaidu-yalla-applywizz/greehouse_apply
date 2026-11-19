import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fillFileField } from '../src/submitter/fieldFillers/fileFiller.js';
import type { ResolvedField } from '../src/types/index.js';

describe('fileFiller - Operator Upload Resolution', () => {
  it('downloads and attaches an operator uploaded resume from storage path', async () => {
    // 1. Prepare a mock operator uploaded file in temp
    const cleanApplywizz = 'AWL-FILLER-TEST';
    const tempDir = path.join(os.tmpdir(), 'resumes', 'operator_uploads', cleanApplywizz);
    fs.mkdirSync(tempDir, { recursive: true });
    const dummyFile = path.join(tempDir, 'app1_resume_uploaded.pdf');
    fs.writeFileSync(dummyFile, '%PDF-1.4 mock operator resume file');

    const storagePath = `operator_uploads/${cleanApplywizz}/app1_resume_uploaded.pdf`;

    let attachedFilePath = '';
    const mockLocator: any = {
      count: async () => 1,
      first: () => mockLocator,
      setInputFiles: async (filePath: string) => {
        attachedFilePath = filePath;
      },
      evaluate: async () => 1,
    };

    const mockPage: any = {
      locator: (_selector: string) => mockLocator,
    };

    const field: ResolvedField = {
      fieldId: 'resume',
      name: 'resume',
      type: 'file',
      label: 'Resume/CV',
      value: storagePath,
      source: 'manual',
      isEdited: true,
      metadata: {
        isOperatorUploaded: true,
        storagePath,
        filename: 'uploaded.pdf',
      },
    };

    const tempFilesToClean: string[] = [];
    const result = await fillFileField(mockPage, field, cleanApplywizz, tempFilesToClean);

    assert.equal(result.success, true);
    assert.ok(attachedFilePath, 'Expected a file path to be set on the locator');
    assert.ok(fs.existsSync(attachedFilePath), 'Attached file must exist on disk');
    const content = fs.readFileSync(attachedFilePath, 'utf-8');
    assert.ok(content.includes('mock operator resume file'));
  });

  it('attaches operator uploaded cover letter when value is present rather than skipping', async () => {
    const cleanApplywizz = 'AWL-FILLER-COVER';
    const tempDir = path.join(os.tmpdir(), 'resumes', 'operator_uploads', cleanApplywizz);
    fs.mkdirSync(tempDir, { recursive: true });
    const dummyFile = path.join(tempDir, 'app2_cover_uploaded.pdf');
    fs.writeFileSync(dummyFile, '%PDF-1.4 mock operator cover letter');

    const storagePath = `operator_uploads/${cleanApplywizz}/app2_cover_uploaded.pdf`;

    let attachedFilePath = '';
    const mockLocator: any = {
      count: async () => 1,
      first: () => mockLocator,
      setInputFiles: async (filePath: string) => {
        attachedFilePath = filePath;
      },
      evaluate: async () => 1,
    };

    const mockPage: any = {
      locator: (_selector: string) => mockLocator,
    };

    const field: ResolvedField = {
      fieldId: 'cover_letter',
      name: 'cover_letter',
      type: 'file',
      label: 'Cover Letter',
      value: storagePath,
      source: 'manual',
      isEdited: true,
      metadata: {
        isOperatorUploaded: true,
        storagePath,
        filename: 'cover.pdf',
      },
    };

    const tempFilesToClean: string[] = [];
    const result = await fillFileField(mockPage, field, cleanApplywizz, tempFilesToClean);

    assert.equal(result.success, true);
    assert.ok(attachedFilePath, 'Expected cover letter to be attached when value exists');
  });
});
