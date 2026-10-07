import { chromium, type Page } from 'playwright';
import { fillSingleField } from '../src/submitter/formFiller.js';

const JOB_URL =
  'https://job-boards.greenhouse.io/doordashusa/jobs/8225722?gh_src=j1uc7xlq1us';

const resolvedFields = [
  ['first_name', 'text', 'First Name', 'SRI KAVYA', true],
  ['last_name', 'text', 'Last Name', 'DAMISETTY', true],
  ['email', 'text', 'Email', 'srikavya.damisetty@applywizard.ai', true],
  ['phone', 'text', 'Phone', '+(913) 295-5219', true],
  ['candidate_location', 'location_autocomplete', 'Candidate Location', 'Fremont, California', true],
  ['resume', 'file', 'Resume/CV', process.env.RESUME_PATH || '', true],
  ['cover_letter', 'file', 'Cover Letter', '', false],
  ['question_69387017', 'text', 'LinkedIn Profile', 'https://www.linkedin.com/in/kavyadamisetty/', true],
  [
    'question_69387018',
    'select',
    'Are you legally authorized to work in the United States?',
    'Yes',
    true,
  ],
  [
    'question_69387019',
    'select',
    'Will you now require immigration sponsorship by our company to attain or maintain your employment eligibility (e.g., H-1B, E-3, TN, O-1, STEM OPT, or any immigration work authorization requiring a written submission from the company to a government agency)?',
    'No',
    true,
  ],
  [
    'question_69387020',
    'select',
    'Will you in the future require immigration sponsorship by our company to attain or maintain your employment eligibility (e.g., H-1B, E-3, TN, O-1, STEM OPT, or any immigration work authorization requiring a written submission from the company to a government agency)?',
    'No',
    true,
  ],
  ['question_69387021', 'select', 'Have you worked at DoorDash?', 'I have not worked at DoorDash', true],
  ['question_69387022', 'select', 'Applicant Privacy Acknowledgement', 'Yes', true],
  [
    'question_69387023',
    'select',
    'Would you like to receive communications via SMS and/or WhatsApp to the number provided [above or during the application process] about your application process? Message & data rates may apply and message frequency may vary. If you select no, we will only communicate with you via email and/or telephone calls. If you select yes and change your mind, you can always reply STOP to opt out.',
    'Yes',
    true,
  ],
  ['country', 'select', 'Country', 'United States', true],
  ['candidate-location', 'location_autocomplete', 'Location (City)', 'Fremont, California', true],
  ['school--0', 'select', 'School', 'University of Central Missouri', false],
  ['degree--0', 'select', 'Degree', 'Masters', false],
  ['864', 'select', 'Gender', 'Female', true],
  ['1328', 'select', 'Do you identify as transgender?', 'No', true],
  ['1332', 'select', 'Are you Hispanic or Latinx?', 'No', true],
  [
    '1333',
    'select',
    'Race (*Please select one option that best describes how you identify*)',
    'Asian',
    true,
  ],
  ['1336', 'select', 'Protected Veteran Status', 'No', true],
  ['1337', 'select', 'Disability Status', 'No', true],
].map(([fieldId, type, label, value, isRequired]) => ({
  name: fieldId,
  fieldId,
  type,
  label,
  value,
  source: 'manual',
  isRequired,
  confidence: 1,
  resolvedByTier: 1,
}));

function installSelectDiagnostics(page: Page): void {
  page.on('console', (message) => {
    if (message.type() === 'debug' || message.type() === 'log' || message.type() === 'info') {
      console.log(`[browser] ${message.text()}`);
    }
  });

  page.on('pageerror', (error) => {
    console.warn(`[browser:error] ${error.message}`);
  });

  page.addInitScript(() => {
    const describe = (element: Element | null): string => {
      if (!element) return 'null';
      const input = element as HTMLInputElement;
      return `${element.tagName.toLowerCase()}#${input.id || '-'}[role=${element.getAttribute('role') || '-'}][class=${element.className || '-'}][value=${input.value || element.textContent?.trim() || '-'}]`;
    };

    document.addEventListener(
      'keydown',
      (event) => {
        const target = event.target as Element | null;
        if (target?.matches('input[role="combobox"], .select__input, .remix-css-input')) {
          console.log(`[select:key] key=${event.key} target=${describe(target)}`);
        }
      },
      true
    );
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target as Element | null;
        if (
          target?.matches(
            '[role="option"], .select__option, [class*="select__option"], .select-shell, input[role="combobox"]'
          )
        ) {
          console.log(`[select:click] target=${describe(target)}`);
        }
      },
      true
    );
    document.addEventListener(
      'change',
      (event) => {
        const target = event.target as Element | null;
        if (
          target?.matches(
            'input[role="combobox"], .select__input, .remix-css-input, input.requiredInput, input[type="hidden"]'
          )
        ) {
          console.log(`[select:change] target=${describe(target)}`);
        }
      },
      true
    );

    setInterval(() => {
      document.querySelectorAll('input.requiredInput, input[class*="requiredInput"]').forEach((input) => {
        const element = input as HTMLInputElement;
        if (element.value) {
          console.log(`[select:hidden] ${describe(element)}`);
        }
      });
    }, 500);
  });
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 120,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  installSelectDiagnostics(page);

  try {
    console.log(`Opening ${JOB_URL}`);
    await page.goto(JOB_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    const fields = resolvedFields.filter(
      (field) => field.type === 'select' || field.type === 'location_autocomplete'
    );
    const tempFiles: string[] = [];
    for (const field of fields) {
      const result = await fillSingleField(
        page,
        field,
        'AWL-DOORDASH-HEADFUL-DEMO',
        tempFiles,
        { timeoutMs: 10_000 }
      );
      const state = await page.evaluate(() => ({
        comboboxes: Array.from(document.querySelectorAll('input[role="combobox"]')).map((input) => ({
          id: input.id,
          value: (input as HTMLInputElement).value,
          expanded: input.getAttribute('aria-expanded'),
        })),
        requiredInputs: Array.from(
          document.querySelectorAll('input.requiredInput, input[class*="requiredInput"]')
        ).map((input) => ({
          className: input.className,
          value: (input as HTMLInputElement).value,
          outerHTML: input.outerHTML,
        })),
        selectedOptions: Array.from(document.querySelectorAll('[role="option"][aria-selected="true"]')).map(
          (option) => option.textContent?.trim()
        ),
      }));
      console.log(`FIELD ${field.fieldId}: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      console.log(JSON.stringify(state, null, 2));
    }

    console.log('Dropdown-only diagnostic finished. No submit action was invoked.');
    const keepOpenMs = Number(process.env.KEEP_OPEN_MS || 60_000);
    console.log(`Browser will remain open for ${Math.round(keepOpenMs / 1000)} seconds. No submit action was invoked.`);
    await page.waitForTimeout(keepOpenMs);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
