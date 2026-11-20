import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fillSingleField, getResumeFileSelectors } from '../src/submitter/formFiller.js';
import type { ResolvedField } from '../src/types/index.js';

describe('Resume Upload Gate & Selectors', () => {
  let browser: Browser;
  let page: Page;
  let tempResumePath: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    tempResumePath = path.join(os.tmpdir(), `test_resume_upload_${Date.now()}.pdf`);
    fs.writeFileSync(tempResumePath, '%PDF-1.4 test resume content');
  });

  afterAll(async () => {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (fs.existsSync(tempResumePath)) {
      try {
        fs.unlinkSync(tempResumePath);
      } catch {}
    }
  });

  it('expands metadataSelector to include file input children when given a container selector', () => {
    const selectors = getResumeFileSelectors('#resume', 'resume', 'resume');
    expect(selectors).toContain('#resume input[type="file"]');
    expect(selectors).toContain('input[type="file"]#resume');
  });

  it('succeeds when page onchange resets input.value or clears files after upload', async () => {
    // Simulates Greenhouse / Remix upload pattern:
    // onChange fires, uploads to server, and resets input.value so re-upload works.
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div id="resume_container" class="field">
          <label>Resume/CV *</label>
          <input type="file" id="resume_input" name="resume" accept=".pdf,.doc,.docx" />
          <div class="uploaded-chip" style="display:none;">resume.pdf</div>
        </div>
        <script>
          document.getElementById('resume_input').addEventListener('change', function() {
            var chip = document.querySelector('.uploaded-chip');
            if (chip) chip.style.display = 'block';
            this.value = ''; // React/Remix clearing files
          });
        </script>
      </body>
      </html>
    `;

    await page.setContent(html);

    const field: ResolvedField = {
      fieldId: 'resume',
      name: 'resume',
      type: 'file',
      label: 'Resume/CV',
      value: tempResumePath,
      isRequired: true,
      source: 'supabase',
      confidence: 1,
    };

    const tempFiles: string[] = [];
    const result = await fillSingleField(page, field, 'AWL-TEST', tempFiles, { timeoutMs: 3000 });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
