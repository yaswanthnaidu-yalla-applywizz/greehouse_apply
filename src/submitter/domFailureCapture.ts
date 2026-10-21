import type { Page } from 'playwright';

export interface FailureDiagnostics {
  failureType: 'field_validation' | 'server_error' | 'resume_missing' | 'otp_error' | 'unknown';
  failingFields: { label: string; fieldId: string; errorText: string }[];
  serverError: string | null;
  pageTitle: string;
  pageUrl: string;
  capturedAt: string;
}

export async function captureFailureDiagnostics(page: Page): Promise<FailureDiagnostics> {
  const [pageTitle, pageUrl] = await Promise.all([
    page.title().catch(() => ''),
    Promise.resolve(typeof page.url === 'function' ? page.url() : ''),
  ]);

  // Collect inline field errors
  const failingFields = await page
    .$$eval('.field-error, [class*="error-message"], [aria-invalid="true"]', (els: any[]) =>
      els
        .map((el) => {
          const dataField = el.closest?.('[data-field]')?.getAttribute?.('data-field');
          const labelText = el.closest?.('label')?.textContent;
          const label = (dataField ?? labelText ?? el.id ?? '').trim();
          const fieldId = el.id ?? '';
          const errorText = (el.textContent ?? '').trim();
          return { label, fieldId, errorText };
        })
        .filter((f) => f.errorText.length > 0)
    )
    .catch(() => []);

  // Detect Greenhouse server-error banner
  const serverErrorPatterns = [
    /there was an error processing your application/i,
    /we were unable to submit/i,
    /something went wrong/i,
    /internal server error/i,
    /a server error occurred/i,
  ];

  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const serverError = serverErrorPatterns.reduce<string | null>(
    (found, re) => found ?? (re.test(bodyText) ? bodyText.slice(0, 200) : null),
    null
  );

  const failureType = serverError
    ? 'server_error'
    : failingFields.length > 0
      ? 'field_validation'
      : 'unknown';

  return {
    failureType,
    failingFields,
    serverError,
    pageTitle,
    pageUrl,
    capturedAt: new Date().toISOString(),
  };
}
