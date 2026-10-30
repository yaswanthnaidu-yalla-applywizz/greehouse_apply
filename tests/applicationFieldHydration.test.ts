import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scannedFieldsToResolvedShells } from '../src/db/applicationFieldHydration.js';

describe('application field hydration', () => {
  it('does not invent Yes/No options for a choice field with no scanned options', () => {
    const [field] = scannedFieldsToResolvedShells([
      {
        fieldId: 'city',
        name: 'city',
        label: 'Which city do you live in?',
        type: 'select',
        isRequired: true,
      },
    ]);

    assert.equal(field.options, undefined);
  });
});
