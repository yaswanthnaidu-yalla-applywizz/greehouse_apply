import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JobQueueViewProps } from '../dashboard/JobQueueView.js';

describe('JobQueueView Client Info Integration', () => {
  it('accepts onOpenClientInfo in JobQueueViewProps interface', () => {
    let clicked = false;
    const props: JobQueueViewProps = {
      candidate: {
        applywizzId: 'AWL-TEST',
        clientName: 'Alex Doe',
        jobs: [],
      },
      selectedApplywizzId: 'AWL-TEST',
      selectedJobUrl: null,
      onBack: () => {},
      onSelectJob: () => {},
      onOpenClientInfo: () => {
        clicked = true;
      },
    };

    assert.strictEqual(typeof props.onOpenClientInfo, 'function');
    props.onOpenClientInfo?.();
    assert.strictEqual(clicked, true);
  });
});
