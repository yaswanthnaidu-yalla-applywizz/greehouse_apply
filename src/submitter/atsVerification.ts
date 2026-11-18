import type { Frame, Page } from 'playwright';
import type { VerificationAts, VerificationProvider } from '../db/applications/types.js';

export type { VerificationAts, VerificationProvider } from '../db/applications/types.js';

export type VerificationObservation =
  | { kind: 'none' }
  | { kind: 'passive_widget'; provider: VerificationProvider }
  | { kind: 'interactive'; provider: VerificationProvider; evidence: 'puzzle' | 'human_prompt' }
  | { kind: 'widget_error'; provider: VerificationProvider; code: string | null };

interface VerificationSurface {
  provider: VerificationProvider;
  visible: boolean;
  text: string;
  widget: boolean;
}

const HUMAN_PROMPT = /verify (?:that )?you are human|confirm (?:that )?you are not a robot|complete (?:the )?(?:captcha|security check)|human verification required/i;
const PUZZLE = /select all (?:the )?images?|click (?:on )?all (?:the )?images?|pick all (?:the )?images?|complete the puzzle|click verify to continue/i;
const WIDGET_ERROR = /(?:error(?:\s+code)?\s*[:#]\s*([a-z0-9_-]+)|invalid[- ]domain[- ]for[- ]site[- ]key|invalid[- ]site[- ]key|missing[- ]input[- ]secret)/i;

function providerFrom(value: string): VerificationProvider {
  const text = value.toLowerCase();
  if (text.includes('hcaptcha')) return 'hcaptcha';
  if (text.includes('turnstile') || text.includes('challenges.cloudflare.com') || text.includes('cloudflare')) return 'turnstile';
  if (text.includes('recaptcha') || text.includes('google.com/recaptcha')) return 'recaptcha';
  return 'unknown';
}

function verificationErrorCode(text: string): string | null {
  const match = text.match(WIDGET_ERROR);
  if (!match) return null;
  const code = match[1] ?? match[0].replace(/^error(?:\s+code)?\s*[:#]\s*/i, '');
  if (/^\d{1,8}$/.test(code)) return code;
  const normalized = code.toLowerCase().replace(/\s+/g, '-');
  const knownCodes: Record<string, string> = {
    'invalid-domain-for-site-key': 'INVALID_DOMAIN_FOR_SITE_KEY',
    'invalid-site-key': 'INVALID_SITE_KEY',
    'missing-input-secret': 'MISSING_INPUT_SECRET',
  };
  return knownCodes[normalized] ?? null;
}

async function frameSurface(frame: Frame): Promise<VerificationSurface | null> {
  if (frame.parentFrame() === null) return null;
  let metadata = '';
  let visible = false;
  try {
    const element = await frame.frameElement();
    const state = await element.evaluate((frameElement) => {
      const iframe = frameElement as HTMLIFrameElement;
      const style = getComputedStyle(iframe);
      const rect = iframe.getBoundingClientRect();
      const isVisible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.visibility !== 'collapse' &&
        parseFloat(style.opacity || '1') > 0.05 &&
        !(style.clip && /rect\(\s*(?:0px?|1px),\s*(?:0px?|1px),\s*(?:0px?|1px),\s*(?:0px?|1px)\s*\)/i.test(style.clip)) &&
        rect.width > 5 &&
        rect.height > 5;
      return {
        attrs: [iframe.getAttribute('src'), iframe.getAttribute('title'), iframe.getAttribute('name'), iframe.getAttribute('id'), iframe.getAttribute('class')].filter(Boolean).join(' '),
        visible: isVisible,
      };
    });
    metadata = state.attrs;
    visible = state.visible;
  } catch {
    return null;
  }
  let text = '';
  try {
    text = (await frame.locator('body').innerText({ timeout: 500 })).slice(0, 4000);
  } catch {
    // An opaque provider frame remains passive evidence from its embedding element.
  }
  const provider = providerFrom(`${metadata} ${frame.url()} ${frame.name()}`);
  if (provider === 'unknown' && !/captcha|turnstile|recaptcha|challenge|verification|security|human/i.test(`${metadata} ${frame.url()} ${frame.name()}`)) return null;
  return { provider, visible, text, widget: true };
}

interface DocumentVerificationEvidence {
  surfaces: Array<{ attrs: string; visible: boolean; text: string }>;
  visibleHumanPrompt: boolean;
  visiblePuzzlePrompt: boolean;
  hasVerificationCopy: boolean;
}

export async function observeAtsVerification(page: Page, _ats: VerificationAts): Promise<VerificationObservation> {
  if (page.isClosed()) return { kind: 'none' };

  const documentEvidence = await page.evaluate<DocumentVerificationEvidence>(`(() => {
    const humanPrompt = /verify (?:that )?you are human|confirm (?:that )?you are not a robot|complete (?:the )?(?:captcha|security check)|human verification required/i;
    const puzzlePrompt = /select all (?:the )?images?|click (?:on )?all (?:the )?images?|pick all (?:the )?images?|complete the puzzle|click verify to continue/i;

    function isRendered(el) {
      if (el.closest('[hidden], [aria-hidden="true"]')) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
      if (parseFloat(s.opacity || '1') <= 0.05) return false;
      if (s.clip && /rect\\(\\s*(?:0px?|1px),\\s*(?:0px?|1px),\\s*(?:0px?|1px),\\s*(?:0px?|1px)\\s*\\)/i.test(s.clip)) return false;
      if (s.clipPath && /inset\\(\\s*(?:50%|100%)\\s*\\)|circle\\(\\s*0(?:px)?\\s*\\)/i.test(s.clipPath)) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;

      let p = el.parentElement;
      while (p && p !== document.body) {
        const ps = getComputedStyle(p);
        if (ps.display === 'none' || ps.visibility === 'hidden' || parseFloat(ps.opacity || '1') <= 0.05) {
          return false;
        }
        p = p.parentElement;
      }
      return true;
    }

    function isUnrelated(el) {
      if (el.closest('iframe, [class*="captcha" i], [id*="captcha" i], [class*="turnstile" i], [id*="turnstile" i], [class*="recaptcha" i], [id*="recaptcha" i], [class*="challenge" i], [id*="challenge" i], [data-qa*="challenge" i], [data-qa*="captcha" i], [role="dialog"], [role="alertdialog"]')) {
        return false;
      }
      if (el.closest('button, [role="button"], input[type="submit"], input[type="checkbox"]')) {
        return false;
      }
      if (el.closest('main, article, [data-qa*="description" i], [class*="description" i], [id*="description" i], [class*="posting" i], .job-body')) {
        return true;
      }
      if (el.tagName === 'P' || el.tagName === 'LI' || el.tagName === 'SECTION') {
        return true;
      }
      const t = el.textContent || '';
      if (t.length > 200 || /\\b(?:role|responsibilities|qualifications|experience|years|requirements|salary|benefits|team|company)\\b/i.test(t)) {
        return true;
      }
      return false;
    }

    const accessiblePrompts = Array.from(document.querySelectorAll('[aria-label], [title]'))
      .filter((el) => !isUnrelated(el) && isRendered(el))
      .map((element) => ({
        text: (element.getAttribute('aria-label') || '') + ' ' + (element.getAttribute('title') || ''),
      }));

    let visibleHumanPrompt = false;
    let visiblePuzzlePrompt = false;
    let hasHiddenVerificationCopy = false;

    const elements = Array.from(document.querySelectorAll('div, span, p, section, button, a, [role="button"]'));
    for (const el of elements) {
      const text = el.textContent || '';
      const hasHuman = humanPrompt.test(text);
      const hasPuzzle = puzzlePrompt.test(text);
      if (!hasHuman && !hasPuzzle) continue;

      if (isUnrelated(el)) continue;

      if (isRendered(el)) {
        if (hasPuzzle) visiblePuzzlePrompt = true;
        if (hasHuman) visibleHumanPrompt = true;
      } else {
        hasHiddenVerificationCopy = true;
      }
    }

    const widgets = Array.from(document.querySelectorAll(
      'iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="recaptcha" i], iframe[src*="challenges.cloudflare.com" i], [id*="captcha" i], [class*="captcha" i], [id*="turnstile" i], [class*="turnstile" i], [id*="recaptcha" i], [class*="recaptcha" i]'
    ));
    const surfaces = widgets.map((element) => ({
      attrs: [element.getAttribute('src'), element.getAttribute('title'), element.getAttribute('id'), element.getAttribute('class')].filter(Boolean).join(' '),
      visible: isRendered(element),
      text: (element.textContent || '').slice(0, 4000),
    }));

    return {
      surfaces,
      visibleHumanPrompt: visibleHumanPrompt || accessiblePrompts.some((prompt) => humanPrompt.test(prompt.text)),
      visiblePuzzlePrompt: visiblePuzzlePrompt || accessiblePrompts.some((prompt) => puzzlePrompt.test(prompt.text)),
      hasVerificationCopy: hasHiddenVerificationCopy || accessiblePrompts.some((prompt) => humanPrompt.test(prompt.text) || puzzlePrompt.test(prompt.text)),
    };
  })()`);

  const frameSurfaces = (await Promise.all(page.frames().map(frameSurface))).filter((surface): surface is VerificationSurface => surface !== null);
  const surfaces: VerificationSurface[] = [
    ...(documentEvidence?.surfaces || []).map((surface) => ({ ...surface, provider: providerFrom(surface.attrs), widget: true })),
    ...frameSurfaces,
  ];
  const documentProvider = surfaces.find((surface) => surface.visible)?.provider ?? surfaces[0]?.provider ?? 'unknown';

  for (const surface of surfaces) {
    if (surface.visible && WIDGET_ERROR.test(surface.text)) {
      return { kind: 'widget_error', provider: surface.provider, code: verificationErrorCode(surface.text) };
    }
  }

  for (const surface of frameSurfaces) {
    if (surface.visible && PUZZLE.test(surface.text)) return { kind: 'interactive', provider: surface.provider, evidence: 'puzzle' };
    if (surface.visible && HUMAN_PROMPT.test(surface.text)) return { kind: 'interactive', provider: surface.provider, evidence: 'human_prompt' };
  }
  if (documentEvidence.visiblePuzzlePrompt) return { kind: 'interactive', provider: documentProvider, evidence: 'puzzle' };
  if (documentEvidence.visibleHumanPrompt) return { kind: 'interactive', provider: documentProvider, evidence: 'human_prompt' };

  const widget = surfaces.find((surface) => surface.widget);
  if (widget || documentEvidence.hasVerificationCopy) {
    return { kind: 'passive_widget', provider: widget?.provider ?? 'unknown' };
  }

  return { kind: 'none' };
}

export function isVerificationResource(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'challenges.cloudflare.com' ||
      (host.endsWith('.cloudflare.com') && parsed.pathname.includes('/turnstile/')) ||
      host === 'hcaptcha.com' ||
      host.endsWith('.hcaptcha.com') ||
      host === 'recaptcha.net' ||
      host.endsWith('.recaptcha.net') ||
      (host === 'www.google.com' && parsed.pathname.includes('/recaptcha/')) ||
      (host === 'www.gstatic.com' && parsed.pathname.includes('/recaptcha/'))
    );
  } catch {
    return false;
  }
}
