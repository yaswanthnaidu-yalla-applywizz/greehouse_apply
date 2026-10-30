/**
 * RC-ASH-2a regression: Resume file input must dispatch a synthetic 'change' event
 * after setInputFiles so that React-controlled Ashby form state updates.
 *
 * Tests that fillAshbyForm:
 * 1. Calls setInputFiles and then dispatches a 'change' event on the file input
 * 2. Waits for the .ashby-file-preview chip to appear (not just native input.files)
 * 3. Falls back to filledFields push when the chip appears after the event
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { fillAshbyForm } from '../src/submitter/ashbyFormFiller.js';
import type { ResolvedField } from '../src/types/index.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

process.env.NODE_ENV = 'test';

describe('RC-ASH-2a: Resume React synthetic change event after setInputFiles', () => {
  let browser: Browser;
  let page: Page;
  let tempResumeFile: string;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    // Create a temp file to act as the resume
    tempResumeFile = path.join(os.tmpdir(), 'test_resume_rc_ash2a.pdf');
    fs.writeFileSync(tempResumeFile, 'PDF content placeholder');
  });

  after(async () => {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (fs.existsSync(tempResumeFile)) fs.unlinkSync(tempResumeFile);
  });

  it('resume upload dispatches a change event that a React-like listener receives', async () => {
    // HTML: file input with a listener that simulates what React does:
    // on 'change', create the .ashby-file-preview chip
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="_systemfield_resume">
          <input type="file" id="resumeInput" />
        </div>
        <script>
          document.getElementById('resumeInput').addEventListener('change', function() {
            // Simulate React's controlled update: add the preview chip when change fires
            var chip = document.createElement('div');
            chip.className = 'ashby-file-preview';
            chip.textContent = this.files[0] ? this.files[0].name : 'uploaded';
            this.parentElement.appendChild(chip);
          });
        </script>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: '_systemfield_resume',
        name: '_systemfield_resume',
        label: 'Resume',
        value: 'resumes/resume_test.pdf',
        type: 'file',
        isRequired: true,
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, tempResumeFile);

    // The resume should be counted as filled because:
    // 1. setInputFiles attached the file
    // 2. The synthetic 'change' event fired
    // 3. The .ashby-file-preview chip appeared
    // 4. fillAshbyForm verified the chip and pushed to filledFields
    assert.equal(
      result.filledCount,
      1,
      'Resume upload must be counted as filled when change event triggers the preview chip'
    );
    assert.equal(result.filledFields.length, 1);
    assert.equal(result.filledFields[0].fieldId, '_systemfield_resume');
    assert.equal(result.filledFields[0].controlType, 'file');

    // Confirm the chip is present in DOM
    const chipExists = await page.$('.ashby-file-preview');
    assert.ok(chipExists, '.ashby-file-preview chip must be present after upload');
  });

  it('resume upload is counted via native input.files even without a preview chip (backward compat)', async () => {
    // When there is NO change listener (no React), native files are sufficient for DOM verification
    const html2 = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="_systemfield_resume">
          <input type="file" id="resumeInput2" />
        </div>
      </body>
      </html>
    `;
    await page.setContent(html2);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: '_systemfield_resume',
        name: '_systemfield_resume',
        label: 'Resume',
        value: 'resumes/resume_test.pdf',
        type: 'file',
        isRequired: true,
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, tempResumeFile);
    // Even without the chip, native input.files verification should pass
    assert.equal(result.filledCount, 1, 'Resume upload must still be counted via native input.files');
  });
});
