import type { Page } from 'playwright';
import { observeAtsVerification } from './atsVerification.js';

export type RipplingPostClickOutcome =
  | { status: 'challenge' }
  | { status: 'unconfirmed' };

export async function detectRipplingPostClickOutcome(
  page: Page,
): Promise<RipplingPostClickOutcome> {
  const observation = await observeAtsVerification(page, 'rippling');
  return observation.kind === 'interactive' ? { status: 'challenge' } : { status: 'unconfirmed' };
}
