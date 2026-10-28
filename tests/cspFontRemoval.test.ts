import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('CSP Font Removal in vite.config.ts', () => {
  test('vite.config.ts does not include external Google Fonts links', () => {
    const config = fs.readFileSync(path.resolve('vite.config.ts'), 'utf-8');
    assert.equal(config.includes('fonts.googleapis.com'), false, 'Google Fonts link must be removed');
    assert.equal(config.includes('fonts.gstatic.com'), false, 'Google Fonts preconnect must be removed');
  });
});
