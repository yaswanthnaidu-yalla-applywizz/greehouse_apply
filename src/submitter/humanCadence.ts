import type { Locator, Page } from 'playwright';

export interface HumanCadenceOptions {
  typingDelayMinMs?: number;
  typingDelayMaxMs?: number;
  fieldGapMinMs?: number;
  fieldGapMaxMs?: number;
  humanize?: boolean;
}

export async function humanType(
  locator: Locator,
  text: string,
  options: HumanCadenceOptions = {}
): Promise<void> {
  const humanize = options.humanize ?? true;
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  if (!humanize) {
    await locator.fill(text);
    return;
  }

  const minDelay = options.typingDelayMinMs ?? 35;
  const maxDelay = options.typingDelayMaxMs ?? 85;

  await locator.click().catch(() => {});
  await locator.fill('');
  const str = String(text);
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    let delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    if ([' ', '.', ',', '?', '!', '-'].includes(char)) {
      delay += Math.floor(Math.random() * 40) + 20;
    }
    await locator.pressSequentially(char, { delay });
  }
}

export async function pauseBetweenFields(
  page: Page,
  options: HumanCadenceOptions = {}
): Promise<void> {
  const humanize = options.humanize ?? true;
  if (!humanize) return;

  const gapMin = options.fieldGapMinMs ?? 400;
  const gapMax = options.fieldGapMaxMs ?? 1100;
  const ms = Math.floor(Math.random() * (gapMax - gapMin + 1)) + gapMin;
  await page.waitForTimeout(ms);
}
