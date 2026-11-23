import { describe, it, expect, vi } from 'vitest';
import {
  isTechnicalOrUuidLabel,
  extractContainerQuestionTitle,
  scrapeLiveFieldFromDom,
} from '../src/submitter/realtimeDomAction.js';
import {
  remediateUncommittedFields,
  type RemediationCandidateContext,
} from '../src/submitter/realtimeRemediator.js';

function createMockLocator(props: Partial<any> = {}) {
  const countFn = typeof props.count === 'function' ? props.count : vi.fn().mockResolvedValue(props.count ?? 0);
  const innerTextFn = typeof props.innerText === 'function'
    ? props.innerText
    : vi.fn().mockResolvedValue(props.innerText || '');
  const loc: any = {
    first: vi.fn(),
    last: vi.fn(),
    nth: vi.fn(),
    locator: vi.fn(),
    getAttribute: vi.fn().mockResolvedValue(props.id || null),
    allTextContents: vi.fn().mockResolvedValue([]),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(props.visible ?? false),
    fill: vi.fn().mockResolvedValue(undefined),
    dispatchEvent: vi.fn().mockResolvedValue(undefined),
    inputValue: vi.fn().mockResolvedValue(''),
    selectOption: vi.fn().mockResolvedValue([]),
    evaluate: vi.fn().mockResolvedValue(''),
    click: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue(undefined),
    uncheck: vi.fn().mockResolvedValue(undefined),
    ...props,
    count: countFn,
    innerText: innerTextFn,
    textContent: innerTextFn,
  };
  loc.first.mockReturnValue(loc);
  loc.last.mockReturnValue(loc);
  loc.nth.mockReturnValue(loc);
  if (!props.locator) {
    loc.locator.mockReturnValue(loc);
  }
  return loc;
}

describe('Ashby Custom Question UUID Label Extraction', () => {
  describe('isTechnicalOrUuidLabel', () => {
    it('identifies standard v4 UUIDs', () => {
      expect(isTechnicalOrUuidLabel('5b81cbd5-298d-4c93-ae16-f829bd1c4ee5')).toBe(true);
      expect(isTechnicalOrUuidLabel('b196cca6-6cb3-4019-8d0f-1eaa7850bc07')).toBe(true);
    });

    it('identifies _systemfield_ tokens', () => {
      expect(isTechnicalOrUuidLabel('_systemfield_name')).toBe(true);
      expect(isTechnicalOrUuidLabel('_systemfield_custom_question')).toBe(true);
    });

    it('identifies single-word technical slugs with long hashes or underscores', () => {
      expect(isTechnicalOrUuidLabel('candidate_education_degree_id')).toBe(true);
      expect(isTechnicalOrUuidLabel('custom-field-64f89b21a3')).toBe(true);
    });

    it('returns false for readable human questions', () => {
      expect(isTechnicalOrUuidLabel('What is your expected salary?')).toBe(false);
      expect(isTechnicalOrUuidLabel('Are you authorized to work in the United States?')).toBe(false);
      expect(isTechnicalOrUuidLabel('Current Company')).toBe(false);
    });
  });

  describe('extractContainerQuestionTitle', () => {
    it('extracts human question title from inner label/div and strips required asterisks', async () => {
      const mockTitleLocator = createMockLocator({
        count: 1,
        innerText: 'What is your desired salary range? *',
      });

      const mockRoot = createMockLocator({
        count: 1,
        locator: vi.fn().mockImplementation((sel: string) => {
          if (sel.includes('label:not') || sel.includes('class*="label"')) {
            return mockTitleLocator;
          }
          return createMockLocator({ count: 0 });
        }),
      });

      const title = await extractContainerQuestionTitle(mockRoot, '5b81cbd5-298d-4c93-ae16-f829bd1c4ee5');
      expect(title).toBe('What is your desired salary range?');
    });

    it('ignores option labels such as Yes or No', async () => {
      const mockOptionLocator = createMockLocator({
        count: 1,
        innerText: 'Yes',
      });

      const mockRoot = createMockLocator({
        count: 1,
        locator: vi.fn().mockReturnValue(mockOptionLocator),
      });

      const title = await extractContainerQuestionTitle(mockRoot, 'fallback-uuid-1234');
      expect(title).toBe('fallback-uuid-1234');
    });
  });

  describe('scrapeLiveFieldFromDom with UUID path', () => {
    it('scrapes field under UUID container and updates label to extracted human title', async () => {
      const uuid = '5b81cbd5-298d-4c93-ae16-f829bd1c4ee5';

      const mockTitleLocator = createMockLocator({
        count: 1,
        innerText: 'What is your target annual compensation? *',
      });

      const mockInput = createMockLocator({
        count: 1,
        id: 'input-target-salary',
        getAttribute: vi.fn().mockResolvedValue('text'),
      });

      const mockContainer = createMockLocator({
        count: 1,
        getAttribute: vi.fn().mockImplementation(async (attr: string) => {
          if (attr === 'data-field-path') return uuid;
          return null;
        }),
        locator: vi.fn().mockImplementation((sel: string) => {
          if (sel.includes('label:not') || sel.includes('class*="label"')) {
            return mockTitleLocator;
          }
          if (sel.includes('input:not')) {
            return mockInput;
          }
          return createMockLocator({ count: 0 });
        }),
      });

      const mockPage: any = {
        locator: vi.fn().mockImplementation((sel: string) => {
          if (sel.includes(`[data-field-path="${uuid}"]`)) {
            return mockContainer;
          }
          return createMockLocator({ count: 0 });
        }),
      };

      const scraped = await scrapeLiveFieldFromDom(mockPage, uuid);
      expect(scraped).not.toBeNull();
      expect(scraped?.label).toBe('What is your target annual compensation?');
      expect(scraped?.type).toBe('text');
      expect(scraped?.locatorSelector).toContain('input');
    });
  });
});
