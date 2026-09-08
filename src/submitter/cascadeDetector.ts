/**
 * @fileoverview Cascading Field Detector Helper (Phase V2-4b).
 *
 * Provides utilities to inspect visible form elements in the live DOM, compare field states
 * before and after user interactions/mutations, and identify newly revealed conditional questions.
 */

import type { Page } from 'playwright';
import type { ScannedField, ScannedFieldType } from '../types/index.js';

/**
 * Normalizes label text by trimming whitespace, stripping trailing asterisks,
 * and removing required/optional annotations.
 */
export function sanitizeLabelText(label: string): string {
  if (!label) return '';
  return label
    .replace(/\s*\*\s*$/, '')
    .replace(/\s*\((?:required|optional)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generates a normalized field identifier from label, name, or DOM id.
 */
export function generateFieldId(name: string, id: string, label: string): string {
  const lowerName = (name || '').toLowerCase();
  const lowerId = (id || '').toLowerCase();
  const lowerLabel = (label || '').toLowerCase();

  // Standard field mappings
  if (lowerName.includes('first_name') || lowerId === 'first_name' || lowerLabel === 'first name') return 'first_name';
  if (lowerName.includes('last_name') || lowerId === 'last_name' || lowerLabel === 'last name') return 'last_name';
  if (lowerName.includes('email') || lowerId === 'email' || lowerLabel === 'email') return 'email';
  if (lowerName.includes('phone') || lowerId === 'phone' || lowerLabel === 'phone') return 'phone';
  if (lowerName.includes('resume') || lowerId === 'resume' || lowerLabel.includes('resume')) return 'resume';
  if (lowerName.includes('cover_letter') || lowerId === 'cover_letter' || lowerLabel.includes('cover letter')) return 'cover_letter';
  if (lowerName.includes('linkedin') || lowerId.includes('linkedin') || lowerLabel.includes('linkedin')) return 'linkedin_url';
  if (lowerName.includes('website') || lowerId.includes('website') || lowerName.includes('portfolio') || lowerLabel.includes('website') || lowerLabel.includes('portfolio')) return 'website_url';
  if (lowerName.includes('location') || lowerId.includes('location') || lowerLabel.includes('location')) return 'location';
  if (lowerName.includes('gender') || lowerId.includes('gender') || lowerLabel === 'gender') return 'gender';
  if (lowerName.includes('hispanic') || lowerId.includes('hispanic') || lowerLabel.includes('hispanic')) return 'hispanic_ethnicity';
  if (lowerName.includes('race') || lowerId.includes('race') || lowerLabel.includes('race') || lowerLabel.includes('ethnic')) return 'race';
  if (lowerName.includes('veteran') || lowerId.includes('veteran') || lowerLabel.includes('veteran')) return 'veteran_status';
  if (lowerName.includes('disability') || lowerId.includes('disability') || lowerLabel.includes('disability')) return 'disability_status';

  // Slugify label if available
  if (label) {
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    if (slug) return slug;
  }

  // Fallback to name or id
  const fallback = (name || id || 'custom_field')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return fallback || 'custom_field';
}

/**
 * Extracts all currently visible form elements from the active Playwright page.
 */
export async function extractVisibleFormFields(page: Page): Promise<ScannedField[]> {
  const rawFields: any[] = await page.evaluate(`
    (() => {
      var fields = [];
      var form = document.querySelector('form#application_form, form#app_form, form') || document.body;
      if (!form) return fields;

      var processedRadioNames = {};

      function clean(str) {
        if (!str) return '';
        return str.replace(/\\s*\\*\\s*$/, '').replace(/\\s*\\((?:required|optional)\\)\\s*$/i, '').replace(/\\s+/g, ' ').trim();
      }

      function isVisible(el) {
        if (!el) return false;
        if (typeof el.checkVisibility === 'function') {
          return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        }
        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        var parent = el.parentElement;
        while (parent && parent !== document.body) {
          var pStyle = window.getComputedStyle(parent);
          if (pStyle.display === 'none' || pStyle.visibility === 'hidden' || pStyle.opacity === '0') return false;
          parent = parent.parentElement;
        }
        var rect = el.getBoundingClientRect();
        return rect.width > 0 || rect.height > 0 || el.getClientRects().length > 0 || el.type === 'file' || el.offsetParent !== null;
      }

      var formElements = Array.from(form.querySelectorAll('input, select, textarea'));

      for (var i = 0; i < formElements.length; i++) {
        var el = formElements[i];
        var rawType = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
        if (rawType === 'hidden' || rawType === 'submit' || rawType === 'button' || rawType === 'reset') continue;

        // Skip invisible elements (unless it is a hidden file upload styled by CSS)
        if (rawType !== 'file' && !isVisible(el)) continue;

        var name = el.getAttribute('name') || '';
        var id = el.getAttribute('id') || '';

        // Ignore internal search input from intl-tel-input
        if (id.indexOf('iti-') === 0 && id.indexOf('search-input') !== -1) continue;
        if (!name && !id) continue;

        // Section name
        var sectionEl = el.closest('fieldset, section, .application-section, [class*="section"]');
        var section = '';
        if (sectionEl) {
          var heading = sectionEl.querySelector('legend, h2, h3, h4, .section-header, [class*="header"]');
          if (heading && heading.textContent) section = clean(heading.textContent);
        }

        // 1. Radio Button Groups
        if (rawType === 'radio') {
          var groupName = name || id;
          if (!groupName || processedRadioNames[groupName]) continue;
          processedRadioNames[groupName] = true;

          var radioGroup = Array.from(form.querySelectorAll('input[type="radio"][name="' + CSS.escape(groupName) + '"]'));
          if (radioGroup.length === 0) continue;

          var firstRadio = radioGroup[0];
          var fieldset = firstRadio.closest('fieldset, .field, [class*="field"], tr, div');
          var groupLabel = '';
          if (fieldset) {
            var labelEl = fieldset.querySelector('legend, label, .field-label, [class*="label"]');
            if (labelEl && labelEl.textContent) groupLabel = clean(labelEl.textContent);
          }

          var options = [];
          for (var j = 0; j < radioGroup.length; j++) {
            var r = radioGroup[j];
            var rId = r.getAttribute('id');
            var labelFor = rId ? document.querySelector('label[for="' + CSS.escape(rId) + '"]') : null;
            var parentLabel = r.closest('label');
            var optText = clean((labelFor && labelFor.textContent) || (parentLabel && parentLabel.textContent) || r.getAttribute('value') || '');
            if (optText && options.indexOf(optText) === -1) options.push(optText);
          }

          var isReq = firstRadio.hasAttribute('required') ||
                      firstRadio.getAttribute('aria-required') === 'true' ||
                      (fieldset && fieldset.textContent && fieldset.textContent.indexOf('*') !== -1);

          fields.push({
            name: groupName,
            id: firstRadio.getAttribute('id') || groupName,
            type: 'radio',
            label: groupLabel || groupName,
            isRequired: !!isReq,
            options: options,
            section: section,
            selector: 'input[type="radio"][name="' + groupName + '"]'
          });
          continue;
        }

        // 2. Select Elements (Native)
        if (el.tagName.toLowerCase() === 'select') {
          var selectEl = el;
          var labelFor = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
          var parentLabel = el.closest('label');
          var fieldWrapper = el.closest('.field, [class*="field"]');
          var wrapperLabel = fieldWrapper ? fieldWrapper.querySelector('label, .field-label') : null;

          var rawLabel = (labelFor && labelFor.textContent) || (parentLabel && parentLabel.textContent) || (wrapperLabel && wrapperLabel.textContent) || el.getAttribute('aria-label') || name;
          var label = clean(rawLabel);

          var options = [];
          for (var k = 0; k < selectEl.options.length; k++) {
            var optText = selectEl.options[k].text ? selectEl.options[k].text.trim() : '';
            if (optText &&
                optText.indexOf('--') !== 0 &&
                optText.indexOf('Please select') !== 0 &&
                optText.indexOf('Select...') !== 0) {
              options.push(optText);
            }
          }

          var isReq = selectEl.required ||
                      selectEl.getAttribute('aria-required') === 'true' ||
                      (rawLabel && rawLabel.indexOf('*') !== -1);

          fields.push({
            name: name || id,
            id: id,
            type: 'select',
            label: label || name || id,
            isRequired: !!isReq,
            options: options,
            section: section,
            selector: id ? '#' + id : 'select[name="' + name + '"]'
          });
          continue;
        }

        // 3. React-Select Combobox Inputs
        var isReactSelect = el.closest('.select__control, [class*="select-control"], .select-shell') !== null;
        if (isReactSelect) {
          var labelFor = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
          var parentLabel = el.closest('label');
          var fieldWrapper = el.closest('.field, [class*="field"], [class*="select-shell"], .select__control');
          var wrapperLabel = fieldWrapper ? fieldWrapper.querySelector('label, .field-label') : null;
          if (!wrapperLabel && fieldWrapper && fieldWrapper.parentElement) {
            wrapperLabel = fieldWrapper.parentElement.querySelector('label, .field-label');
          }

          var rawLabel = (labelFor && labelFor.textContent) ||
                         (parentLabel && parentLabel.textContent) ||
                         (wrapperLabel && wrapperLabel.textContent) ||
                         el.getAttribute('aria-label') ||
                         name ||
                         id;
          var label = clean(rawLabel);

          var isReq = el.required ||
                      el.getAttribute('aria-required') === 'true' ||
                      (rawLabel && rawLabel.indexOf('*') !== -1);

          var detectedType = (name.indexOf('location') !== -1 || id.indexOf('location') !== -1 || label.toLowerCase().indexOf('location') !== -1)
            ? 'location_autocomplete'
            : 'select';

          fields.push({
            name: name || id,
            id: id,
            type: detectedType,
            label: label || name || id,
            isRequired: !!isReq,
            options: [],
            section: section,
            selector: id ? '#' + id : 'input#' + CSS.escape(id)
          });
          continue;
        }

        // 4. Standard Text, Textarea, File, Checkbox, Location
        var labelFor = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
        var parentLabel = el.closest('label');
        var fieldWrapper = el.closest('.field, [class*="field"]');
        var wrapperLabel = fieldWrapper ? fieldWrapper.querySelector('label, .field-label') : null;

        var rawLabel = (labelFor && labelFor.textContent) ||
                       (parentLabel && parentLabel.textContent) ||
                       (wrapperLabel && wrapperLabel.textContent) ||
                       el.getAttribute('aria-label') ||
                       el.getAttribute('placeholder') ||
                       name ||
                       id;
        var label = clean(rawLabel);

        var detectedType = 'text';
        if (el.tagName.toLowerCase() === 'textarea') {
          detectedType = 'textarea';
        } else if (rawType === 'file') {
          detectedType = 'file';
        } else if (rawType === 'checkbox') {
          detectedType = 'checkbox';
        } else if (
          name.toLowerCase().indexOf('location') !== -1 ||
          id.toLowerCase().indexOf('location') !== -1 ||
          label.toLowerCase().indexOf('location') !== -1
        ) {
          detectedType = 'location_autocomplete';
        }

        var isReq = el.required ||
                    el.getAttribute('aria-required') === 'true' ||
                    (rawLabel && rawLabel.indexOf('*') !== -1);

        fields.push({
          name: name || id,
          id: id,
          type: detectedType,
          label: label || name || id,
          isRequired: !!isReq,
          section: section,
          selector: id ? '#' + id : 'input[name="' + name + '"]'
        });
      }

      return fields;
    })()
  `);

  return (rawFields || []).map((f) => {
    const fieldId = generateFieldId(f.name, f.id, f.label);
    const scannedField: ScannedField = {
      fieldId,
      name: f.name || f.id || fieldId,
      type: f.type as ScannedFieldType,
      label: sanitizeLabelText(f.label) || fieldId,
      isRequired: !!f.isRequired,
    };

    if (f.options && f.options.length > 0) {
      scannedField.options = f.options;
    }

    if (f.section || f.selector) {
      scannedField.metadata = {
        section: f.section || undefined,
        selector: f.selector || undefined,
      };
    }

    return scannedField;
  });
}

/**
 * Identifies unmapped visible fields in the DOM by filtering out already processed fields.
 */
export async function getUnmappedVisibleFields(
  page: Page,
  knownFieldIds: Set<string>,
  knownNames: Set<string>
): Promise<ScannedField[]> {
  const currentVisible = await extractVisibleFormFields(page);
  return currentVisible.filter((f) => {
    if (knownFieldIds.has(f.fieldId)) return false;
    if (f.name && knownNames.has(f.name)) return false;
    return true;
  });
}
