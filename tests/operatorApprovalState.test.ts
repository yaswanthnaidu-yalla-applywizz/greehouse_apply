import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serializeApplicationDto } from '../src/db/applications/dto.js';

describe('operator approval state', () => {
  it('serializes the explicit operator approval timestamp without deriving it from reviewed_at', () => {
    const dto = serializeApplicationDto({
      id: 'app-1',
      applywizz_id: 'AWL-1',
      job_url: 'https://jobs.example/1',
      status: 'READY_FOR_REVIEW',
      resolved_fields: [],
      reviewed_at: '2026-10-30T01:00:00.000Z',
      operator_approved_at: null,
    } as any);

    assert.equal(dto.operator_approved_at, null);
    assert.equal(dto.operatorApprovedAt, null);
  });

  it('serializes an explicit approval timestamp when present', () => {
    const approvedAt = '2026-10-30T02:00:00.000Z';
    const dto = serializeApplicationDto({
      id: 'app-2',
      applywizz_id: 'AWL-2',
      job_url: 'https://jobs.example/2',
      status: 'APPLIED',
      resolved_fields: [],
      reviewed_at: null,
      operator_approved_at: approvedAt,
    } as any);

    assert.equal(dto.operator_approved_at, approvedAt);
    assert.equal(dto.operatorApprovedAt, approvedAt);
  });
});
