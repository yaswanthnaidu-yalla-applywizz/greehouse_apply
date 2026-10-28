import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { scanAshbyJob } from '../src/scanner/ashbyScanner.js';

test('Ashby scans required and optional questions from the application DOM', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<html><head><title>Engineer @ Example</title></head><body>
      <div data-field-path="_systemfield_resume"><label>Resume *</label><input type="file"></div>
      <div data-field-path="custom_optional"><label>Referral source</label><select><option>LinkedIn</option></select></div>
    </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const template = await scanAshbyJob(`http://127.0.0.1:${address.port}/example/job`);
    assert.equal(template.companyName, 'Example');
    assert.deepEqual(template.fields.map((field) => [field.fieldId, field.type, field.isRequired]), [
      ['_systemfield_resume', 'file', true],
      ['custom_optional', 'select', false],
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
