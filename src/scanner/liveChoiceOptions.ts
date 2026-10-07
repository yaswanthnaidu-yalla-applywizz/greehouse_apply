import type { Page } from 'playwright';
import type { ScannedField } from '../types/index.js';

const PLACEHOLDER_OPTIONS = new Set([
  'select',
  'select...',
  'choose',
  'choose...',
  'please select',
  'please select...',
  'select an option',
]);

function cleanOptions(options: string[]): string[] {
  return [...new Set(options.map((option) => option.trim()).filter((option) => (
    option.length > 0 && !PLACEHOLDER_OPTIONS.has(option.toLowerCase())
  )))];
}

function attributeSelector(attribute: string, value: string): string {
  return `[${attribute}=${JSON.stringify(value)}]`;
}

export async function enrichMissingChoiceOptions(
  page: Page,
  fields: ScannedField[],
  onUnresolved?: (field: ScannedField, reason: string) => void,
): Promise<ScannedField[]> {
  const result = fields.map((field) => ({ ...field }));
  const targets = result
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => (
      field.isRequired &&
      (field.type === 'select' || field.type === 'radio') &&
      (!Array.isArray(field.options) || field.options.length === 0)
    ));

  if (targets.length === 0) return result;

  const descriptors = targets.map(({ field }) => ({
    name: field.name,
    fieldId: field.fieldId,
  }));

  const staticOptions = await page.evaluate(`
    (() => {
      var items = ${JSON.stringify(descriptors)};
      var placeholder = /^(select(?:\\.\\.\\.)?|choose(?:\\.\\.\\.)?|please select(?:\\.\\.\\.)?|select an option)$/i;
      var findField = function(item) {
        for (var value of [item.name, item.fieldId]) {
          if (!value) continue;
          var escaped = CSS.escape(value);
          var quoted = value.replace(/["\\\\]/g, '\\\\$&');
          var found = document.querySelector('[id="' + quoted + '"], [name="' + quoted + '"]')
            || document.querySelector('#' + escaped);
          if (found) return found;
        }
        return null;
      };
      var isVisible = function(element) {
        if (!element) return false;
        var style = window.getComputedStyle(element);
        var rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          (rect.width > 0 || rect.height > 0 || element.getClientRects().length > 0);
      };
      return items.map(function(item) {
        var field = findField(item);
        var wrapper = field && (field.closest('.select__container, .field, .application-question, .form-field, fieldset')
          || field.parentElement);
        var select = field && field.tagName === 'SELECT' && isVisible(field) ? field : null;
        if (!select && wrapper) {
          var selects = Array.from(wrapper.querySelectorAll('select'));
          select = selects.find(isVisible) || null;
        }
        if (select) {
          return {
            options: Array.from(select.querySelectorAll('option'))
              .map(function(option) { return (option.textContent || '').trim(); })
              .filter(function(text) { return text && !placeholder.test(text); }),
            complete: true
          };
        }
        var radioInputs = wrapper ? Array.from(wrapper.querySelectorAll('input[type="radio"]')) : [];
        if (radioInputs.length > 0) {
          return {
            options: radioInputs.map(function(input) {
              var id = input.getAttribute('id');
              var escapedId = id ? id.replace(/["\\\\]/g, '\\\\$&') : '';
              var label = escapedId ? document.querySelector('label[for="' + escapedId + '"]') : null;
              return ((label && label.textContent) || input.getAttribute('value') || '').trim();
            }).filter(Boolean),
            complete: true
          };
        }
        return { options: [], complete: false };
      });
    })()
  `) as Array<{ options: string[]; complete: boolean }>;

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    const { field, index } = targets[targetIndex];
    if (field.type === 'select') result[index].optionsComplete = false;
    const foundStatic = cleanOptions(staticOptions[targetIndex]?.options || []);
    if (foundStatic.length > 0) {
      result[index].options = foundStatic;
      result[index].optionsComplete = staticOptions[targetIndex].complete;
      continue;
    }
    if (field.type !== 'select') {
      onUnresolved?.(field, 'no native choice controls found');
      continue;
    }

    let wrapper: ReturnType<Page['locator']> | undefined;
    for (const value of [field.name, field.fieldId]) {
      if (!value) continue;
      const label = page.locator(`label[for=${JSON.stringify(value)}]`).first();
      if (await label.count() && await label.isVisible()) {
        wrapper = label.locator('xpath=..');
        break;
      }
    }
    if (!wrapper) {
      onUnresolved?.(field, 'visible label has no recognized dropdown wrapper');
      continue;
    }

    const trigger = wrapper.locator(
      '[role="combobox"], .select__input, .select__control, [aria-haspopup="listbox"], [aria-expanded]',
    ).first();
    if (!(await trigger.count())) {
      onUnresolved?.(field, 'visible label has no recognized dropdown trigger');
      continue;
    }
    if (!(await trigger.isVisible())) continue;

    let opened = false;
    try {
      await trigger.click({ timeout: 1500 });
      opened = true;
      await page.waitForTimeout(100);

      const controlsId = await trigger.getAttribute('aria-controls');
      let optionsLocator = controlsId
        ? page.locator(
          `${attributeSelector('id', controlsId)} [role="option"], ${attributeSelector('id', controlsId)} .select__option`,
        )
        : wrapper.locator('[role="option"], .select__option');
      let optionTexts = await visibleTexts(optionsLocator);
      if (optionTexts.length === 0) {
        optionsLocator = page.locator('[role="option"]:visible, .select__option:visible');
        optionTexts = await visibleTexts(optionsLocator);
      }

      const customOptions = cleanOptions(optionTexts);
      if (customOptions.length > 0) {
        result[index].options = customOptions;
        result[index].optionsComplete = await isCompleteCustomMenu(optionsLocator);
        if (!result[index].optionsComplete) {
          onUnresolved?.(field, 'visible menu appears scrollable or virtualized; captured options are partial');
        }
      } else {
        result[index].optionsComplete = false;
        onUnresolved?.(field, 'dropdown opened but no visible options were found');
      }
    } catch (error) {
      onUnresolved?.(
        field,
        `dropdown interaction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (opened) {
        try {
          await page.keyboard.press('Escape');
        } catch (error) {
          onUnresolved?.(
            field,
            `could not close dropdown after reading options: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  return result;
}

async function isCompleteCustomMenu(optionsLocator: ReturnType<Page['locator']>): Promise<boolean> {
  if ((await optionsLocator.count()) === 0) return false;
  return optionsLocator.first().evaluate((option: HTMLElement) => {
    const list = option.closest<HTMLElement>('[role="listbox"], .select__menu') || option.parentElement;
    const declaredSize = Number(
      option.getAttribute('aria-setsize') ||
      list?.getAttribute('aria-setsize') ||
      0
    );
    const renderedOptions = list?.querySelectorAll('[role="option"], .select__option').length || 0;
    if (declaredSize === -1 || declaredSize > renderedOptions) return false;

    let current = list;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        current.scrollHeight > current.clientHeight + 2
      ) {
        return false;
      }
      current = current.parentElement;
    }
    return true;
  });
}

async function visibleTexts(locator: ReturnType<Page['locator']>): Promise<string[]> {
  const texts: string[] = [];
  const count = await locator.count();
  for (let index = 0; index < count; index++) {
    const option = locator.nth(index);
    if (await option.isVisible()) {
      const text = (await option.innerText()).trim();
      if (text) texts.push(text);
    }
  }
  return texts;
}
