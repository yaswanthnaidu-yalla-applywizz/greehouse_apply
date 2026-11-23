import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { scrapeLiveFieldFromDom, commitRemediatedValue, type ScrapedDomField } from '../src/submitter/realtimeDomAction.js';

function createMockLocator(props: Partial<any> = {}) {
  const countFn = typeof props.count === 'function'
    ? props.count
    : vi.fn().mockResolvedValue(props.count ?? 0);
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
  };
  loc.first.mockReturnValue(loc);
  loc.last.mockReturnValue(loc);
  loc.nth.mockReturnValue(loc);
  if (!props.locator) {
    loc.locator.mockReturnValue(loc);
  }
  return loc;
}

describe('Real-Time DOM Action - File Upload Dropzone Handling', () => {
  it('scrapes file input elements when label is Resume or _systemfield_resume', async () => {
    const fileInputLocator = createMockLocator({
      count: 1,
      getAttribute: vi.fn().mockImplementation(async (attr: string) => {
        if (attr === 'id') return 'resume-upload-input';
        if (attr === 'name') return 'resume';
        return null;
      }),
    });

    const rootLocator = createMockLocator({
      count: 1,
      getAttribute: vi.fn().mockResolvedValue('resume-container'),
      locator: vi.fn().mockImplementation((sel: string) => {
        if (sel === 'input[type="file"]') return fileInputLocator;
        return createMockLocator({ count: 0 });
      }),
    });

    const mockPage: any = {
      locator: vi.fn().mockImplementation((sel: string) => {
        if (sel.includes('_systemfield_resume')) {
          return rootLocator;
        }
        if (sel === 'input[type="file"]') {
          return fileInputLocator;
        }
        return createMockLocator({ count: 0 });
      }),
    };

    const result = await scrapeLiveFieldFromDom(mockPage, '_systemfield_resume');
    expect(result).not.toBeNull();
    expect(result?.type).toBe('file');
    expect(result?.isFileDropzone).toBe(true);
    expect(result?.locatorSelector).toContain('input[type="file"]');
  });

  it('attaches file to file input on commitRemediatedValue', async () => {
    const tmpFile = path.resolve(process.cwd(), 'tests', 'fixtures_dummy_resume.pdf');
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, '%PDF-1.4 dummy content');

    try {
      const setInputFilesMock = vi.fn().mockResolvedValue(undefined);
      const fileInputLocator = createMockLocator({
        count: 1,
        setInputFiles: setInputFilesMock,
      });

      const mockPage: any = {
        locator: vi.fn().mockReturnValue(fileInputLocator),
      };

      const field: ScrapedDomField = {
        found: true,
        label: 'Resume',
        type: 'file',
        options: [],
        locatorSelector: 'input[type="file"]',
        isFileDropzone: true,
      };

      const decision: any = {
        fieldId: 'resume',
        value: tmpFile,
      };

      const result = await commitRemediatedValue(mockPage, field, decision);
      expect(result.success).toBe(true);
      expect(setInputFilesMock).toHaveBeenCalledWith(tmpFile, { timeout: 5000 });
      expect(result.committedValue).toBe('fixtures_dummy_resume.pdf');
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  });

  it('recognizes existing preview chip if file is already attached', async () => {
    const previewChipLocator = createMockLocator({
      count: 1,
      visible: true,
      isVisible: vi.fn().mockResolvedValue(true),
    });

    const rootLocator = createMockLocator({
      count: 1,
      locator: vi.fn().mockImplementation((sel: string) => {
        if (sel.includes('file') || sel.includes('chip') || sel.includes('uploaded')) {
          return previewChipLocator;
        }
        return createMockLocator({ count: 0 });
      }),
    });

    const mockPage: any = {
      locator: vi.fn().mockReturnValue(rootLocator),
    };

    const field: ScrapedDomField = {
      found: true,
      label: 'Resume / CV',
      type: 'file',
      options: [],
      locatorSelector: 'input[type="file"]',
      isFileDropzone: true,
      containerSelector: '.resume-container',
    };

    const decision: any = {
      fieldId: 'resume',
      value: 'non_existent_path.pdf',
    };

    const result = await commitRemediatedValue(mockPage, field, decision);
    expect(result.success).toBe(true);
    expect(result.committedValue).toBe('existing_file_verified');
  });
});
