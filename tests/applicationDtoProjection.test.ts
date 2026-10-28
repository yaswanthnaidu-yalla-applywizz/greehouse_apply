import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { APPLICATION_SUMMARY_COLUMNS } from '../src/server/types/applicationDtos.js';

describe('Partitioned Application DTOs', () => {
  test('summary columns definition excludes resolved_fields and user_inputs', () => {
    assert.ok(APPLICATION_SUMMARY_COLUMNS.includes('id'));
    assert.ok(APPLICATION_SUMMARY_COLUMNS.includes('status'));
    assert.ok(APPLICATION_SUMMARY_COLUMNS.includes('job_title'));
    assert.equal(APPLICATION_SUMMARY_COLUMNS.includes('resolved_fields'), false);
    assert.equal(APPLICATION_SUMMARY_COLUMNS.includes('user_inputs'), false);
  });
});
