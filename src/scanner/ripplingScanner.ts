import type { Page } from 'playwright';
import type { ScannedField, ScannedFieldType, ScannedJobTemplate } from '../types/index.js';
import { observeAtsVerification } from '../submitter/atsVerification.js';

/** Extracts fields from an already-open Rippling application page without navigating or mutating it. */
export async function extractRipplingFieldsFromPage(page: Page, url: string): Promise<ScannedJobTemplate> {
  const verification = await observeAtsVerification(page, 'rippling');
  const pageInfo = await page.evaluate(() => {
    const bodyText = document.body?.innerText ?? '';
    const title = document.title.trim();
    const closed = /job (?:is )?(?:closed|no longer available)|position (?:has been filled|is no longer accepting)|no longer accepting applications|this role has been filled/i.test(bodyText);
    const blocked = /checking your browser|access denied|unusual traffic/i.test(bodyText);

    const controls = Array.from(document.querySelectorAll('input, textarea, select, [role="combobox"], [role="textbox"], [role="radio"], [role="checkbox"]'))
      .filter((element) => {
        const style = getComputedStyle(element);
        if (element.closest('[hidden]') || element.matches(':disabled') ||
          (element.closest('[aria-hidden="true"]') && !(element instanceof HTMLInputElement && element.type === 'file'))) return false;
        if (element instanceof HTMLInputElement && element.type === 'file' && (style.display === 'none' || style.visibility === 'hidden' || !element.getClientRects().length)) {
          const wrapper = element.closest('[data-testid="field"], [class*="field" i], [class*="question" i], [role="group"]');
          const labelIds = element.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
          const hasVisibleLabel = Array.from(element.labels ?? []).some((label) => Boolean(label.getClientRects().length)) ||
            labelIds.some((id) => Boolean(document.getElementById(id)?.getClientRects().length)) ||
            Boolean(wrapper?.querySelector('[id$="-label"], label, legend, [role="label"]'));
          const hasVisibleUpload = Array.from(wrapper?.querySelectorAll('button, [role="button"], label') ?? []).some((trigger) => {
            const triggerStyle = getComputedStyle(trigger);
            return triggerStyle.display !== 'none' && triggerStyle.visibility !== 'hidden' && Boolean(trigger.getClientRects().length);
          });
          return Boolean(wrapper && hasVisibleLabel && hasVisibleUpload);
        }
        if (style.display === 'none' || style.visibility === 'hidden' || !element.getClientRects().length) return false;
        if (element instanceof HTMLInputElement) return !['hidden', 'submit', 'button', 'reset', 'image'].includes(element.type);
        return true;
      });
    const grouped = new Map<string, Element[]>();
    for (const control of controls) {
      const nativeName = control.getAttribute('name')?.trim();
      const customGroup = control.getAttribute('role') === 'radio'
        ? control.closest('[role="radiogroup"]') ?? control.closest('[data-testid="field"], [class*="field" i], [class*="question" i]')
        : control.getAttribute('role') === 'checkbox'
          ? control.closest('[role="group"]') ?? control.closest('[data-testid="field"], [class*="field" i], [class*="question" i]')
          : null;
      const groupKey = customGroup
        ? `${control.getAttribute('role')}:${controls.findIndex((candidate) => customGroup.contains(candidate))}`
        : control instanceof HTMLInputElement && ['radio', 'checkbox'].includes(control.type) && nativeName
          ? `${control.tagName}:${control.type}:${nativeName}`
          : `single:${controls.indexOf(control)}`;
      const group = grouped.get(groupKey) ?? [];
      group.push(control);
      grouped.set(groupKey, group);
    }

    const fieldIdentities = new Set<string>();
    const fields = Array.from(grouped.entries()).map(([groupKey, group]) => {
      const control = group[0];
      const input = control instanceof HTMLInputElement ? control : null;
      const nativeName = control.getAttribute('name')?.trim() || control.querySelector('input[name]')?.getAttribute('name')?.trim() || '';
      const id = control.id.trim();
      const phoneCodeContext = control.closest('[data-testid="phone_number-code"]');
      const contextTestId = phoneCodeContext?.getAttribute('data-testid') || '';
      const fieldContainer = control.closest('fieldset, [data-testid="field"], [class*="field" i], [class*="question" i], [role="group"]');
      const container = fieldContainer ?? control.parentElement;
      const labels = Array.from((control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) ? control.labels ?? [] : []);
      const labelledByText = (control.getAttribute('aria-labelledby')?.split(/\s+/) ?? [])
        .map((labelId) => document.getElementById(labelId)?.textContent ?? '').filter(Boolean).join(' ');
      const fieldLabelElement = fieldContainer?.querySelector('[id$="-label"], label, legend, [role="label"], [data-label]');
      const radioGroup = control.closest('[role="radiogroup"]');
      const groupLabel = control.closest('fieldset')?.querySelector('legend')?.textContent ||
        (radioGroup?.getAttribute('aria-labelledby')?.split(/\s+/) ?? []).map((labelId) => document.getElementById(labelId)?.textContent ?? '').filter(Boolean).join(' ') ||
        radioGroup?.getAttribute('aria-label') ||
        (fieldContainer?.getAttribute('aria-labelledby')?.split(/\s+/) ?? []).map((labelId) => document.getElementById(labelId)?.textContent ?? '').filter(Boolean).join(' ') ||
        fieldLabelElement?.textContent ||
        (fieldContainer?.getAttribute('role') === 'group' ? fieldContainer.getAttribute('aria-label') : null);
      const labelSource = labelledByText || (phoneCodeContext ? 'Phone country code' : '') || groupLabel || labels.map((label) => label.textContent ?? '').join(' ') ||
        control.getAttribute('aria-label') || control.getAttribute('placeholder') || '';
      const labelText = labelSource
        .replace(/\s+/g, ' ').replace(/\s*\*\s*/g, ' ').replace(/\s+required\s*$/i, '').trim();
      const required = group.some((item) => item.hasAttribute('required') || item.getAttribute('aria-required') === 'true') ||
        container?.getAttribute('aria-required') === 'true' ||
        Boolean(container?.matches('fieldset, [data-testid="field"], [class*="field" i], [class*="question" i], [role="group"], [role="radiogroup"]') && container.querySelector('[aria-required="true"], .required, [class*="required" i], [aria-label*="required" i], [id$="-label"] + span')) ||
        labels.some((label) => /\*/.test(label.textContent ?? '') || /\brequired\b/i.test(label.textContent ?? '')) ||
        /\*/.test(labelledByText) || /\brequired\b/i.test(labelledByText) ||
        container?.querySelector('[id$="-label"]')?.nextElementSibling?.textContent?.trim() === '*';
      const genericLabel = /^(?:search|select|choose|choose one|type to search|upload|upload file)$/i.test(labelText);
      const letters = labelText.replace(/[^a-z]/gi, '');
      const vowels = (letters.match(/[aeiou]/gi) ?? []).length;
      const gibberishLabel = /^[a-z0-9_-]{8,}$/i.test(labelText) && (vowels / Math.max(letters.length, 1) < 0.22 || labelText.length >= 28);
      const ambiguousPhoneSearch = !phoneCodeContext && control.getAttribute('role') === 'combobox' && /^search$/i.test(control.getAttribute('aria-label') ?? '') &&
        /phone/i.test(groupLabel ?? '') && Boolean(fieldContainer?.querySelector('input[type="tel"]'));
      if (required && (!labelText || genericLabel || gibberishLabel || ambiguousPhoneSearch)) {
        throw new Error(`Rippling required field has no stable identity or accessible label (control ${groupKey})`);
      }
      if (!labelText || genericLabel || gibberishLabel || ambiguousPhoneSearch) {
        throw new Error(`Rippling field has an ambiguous or unusable accessible label: ${labelText || groupKey}`);
      }
      const identity = contextTestId || id || nativeName || fieldLabelElement?.id || labelText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!identity) return null;
      if (fieldIdentities.has(identity)) throw new Error(`Rippling scan found duplicate field identity: ${identity}`);
      fieldIdentities.add(identity);
      if (contextTestId && Array.from(document.querySelectorAll('[data-testid]')).filter((element) => element.getAttribute('data-testid') === contextTestId).length !== 1) {
        throw new Error(`Rippling scan found a non-unique field selector for ${contextTestId}`);
      }
      const name = nativeName || id || identity;
      let type: ScannedFieldType = 'text';
      let options: string[] | undefined;
      let optionsComplete: boolean | undefined;
      if (control instanceof HTMLTextAreaElement) type = 'textarea';
      else if (control instanceof HTMLSelectElement) {
        type = 'select';
        options = Array.from(control.options).map((option) => option.text.trim()).filter(Boolean);
      } else if (input?.type === 'date') type = 'date';
      else if (input?.type === 'file') type = 'file';
      else if (input?.type === 'radio') {
        type = 'radio';
        options = group.map((item) => {
          if (!(item instanceof HTMLInputElement)) return '';
          const radio = item;
          return Array.from(radio.labels ?? []).map((label) => label.textContent?.trim() ?? '').filter(Boolean).join(' ') || radio.getAttribute('aria-label') || radio.value;
        }).filter(Boolean);
      } else if (input?.type === 'checkbox') {
        type = 'checkbox';
        options = group.map((item) => {
          if (!(item instanceof HTMLInputElement)) return '';
          const checkbox = item;
          return Array.from(checkbox.labels ?? []).map((label) => label.textContent?.trim() ?? '').filter(Boolean).join(' ') || checkbox.getAttribute('aria-label') || checkbox.value;
        }).filter(Boolean);
      } else if (control.getAttribute('role') === 'radio') {
        type = 'radio';
        options = group.map((item) => (item.getAttribute('aria-labelledby')?.split(/\s+/) ?? []).map((labelId) => document.getElementById(labelId)?.textContent ?? '').filter(Boolean).join(' ') || item.getAttribute('aria-label') || item.textContent?.trim() || '').filter(Boolean);
      } else if (control.getAttribute('role') === 'checkbox') {
        type = 'checkbox';
        options = group.map((item) => item.getAttribute('aria-label') || item.textContent?.trim() || '').filter(Boolean);
      } else if (control.getAttribute('role') === 'combobox') {
        type = 'select';
        options = Array.from(document.querySelectorAll('[role="option"]')).filter((option) => {
          const style = getComputedStyle(option);
          return !option.closest('[hidden], [aria-hidden="true"]') && style.display !== 'none' && style.visibility !== 'hidden' && Boolean(option.getClientRects().length);
        }).map((option) => option.textContent?.trim() ?? '').filter(Boolean);
        optionsComplete = false;
      }
      return { name, label: labelText || name, type, isRequired: required, options, optionsComplete, fieldId: identity, selector: contextTestId ? `[data-testid="${contextTestId}"]` : undefined };
    }).filter((field) => field !== null);
    const requiredSignals = Array.from(document.querySelectorAll('[required], [aria-required="true"], label, legend, [class*="required" i], [id$="-label"] + span')).filter((signal) => {
      const style = getComputedStyle(signal);
      if (signal.closest('[hidden], [aria-hidden="true"]') || style.display === 'none' || style.visibility === 'hidden' || !signal.getClientRects().length) return false;
      return signal.hasAttribute('required') || signal.getAttribute('aria-required') === 'true' || /\*/.test(signal.textContent ?? '') || /\brequired\b/i.test(signal.textContent ?? '') || /required/i.test(signal.getAttribute('class') ?? '');
    });
    for (const signal of requiredSignals) {
      const markerRoot = signal.closest('fieldset, [data-testid="field"], [class*="field" i], [class*="question" i], [role="group"], [role="radiogroup"]');
      if (markerRoot) {
        const unknownInteractive = Array.from(markerRoot.querySelectorAll('button, [role="button"], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')).filter((element) => {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || !element.getClientRects().length) return false;
          if (element instanceof HTMLButtonElement && ['submit', 'reset'].includes(element.type)) return false;
          const recognized = controls.some((control) => control === element || control.contains(element) || element.contains(control));
          const fileUploadTrigger = controls.some((control) => control instanceof HTMLInputElement && control.type === 'file' &&
            Boolean(element.closest('label')?.contains(control)));
          return !recognized && !fileUploadTrigger;
        });
        if (unknownInteractive.length > 0) throw new Error(`Rippling required field contains an unrecognized interactive control: ${markerRoot.getAttribute('data-testid') || markerRoot.tagName.toLowerCase()}`);
      }
      const associated = controls.some((control) => signal === control || signal.contains(control) || control.contains(signal) ||
        (signal instanceof HTMLLabelElement && (signal.control === control || signal.htmlFor === control.id)) ||
        Boolean(markerRoot?.contains(control)));
      if (!associated) throw new Error(`Rippling required marker has no captured control: ${(signal.textContent ?? '').trim()}`);
    }
    return { title, closed, blocked, fields };
  });

  if (pageInfo.blocked || verification.kind === 'interactive') throw new Error(`Rippling scan blocked by challenge or access gate: ${url}`);
  if (!pageInfo.closed && pageInfo.fields.length === 0) throw new Error(`Rippling scan yielded zero fields on an unrecognized page: ${url}`);
  const titleParts = pageInfo.title.split(/\s+[|–—]\s+/);
  return {
    jobUrl: url,
    companyName: titleParts.length > 1 ? titleParts.at(-1) ?? 'Rippling' : 'Rippling',
    jobTitle: titleParts.length > 1 ? titleParts.slice(0, -1).join(' | ') : pageInfo.title || 'Rippling Opportunity',
    fields: pageInfo.fields.map((field): ScannedField => ({
      fieldId: field.fieldId,
      name: field.name,
      type: field.type,
      label: field.label,
      isRequired: field.isRequired,
      options: field.options,
      optionsComplete: field.optionsComplete,
      metadata: field.selector ? { selector: field.selector } : undefined,
    })),
    scannedAt: new Date().toISOString(),
    isExpired: pageInfo.closed,
  };
}
