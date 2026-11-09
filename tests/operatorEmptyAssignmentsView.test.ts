import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('operator empty-assignment dashboard state', () => {
  const app = fs.readFileSync(path.resolve(process.cwd(), 'dashboard/App.tsx'), 'utf8');

  it('renders a dedicated empty state with refresh and date controls', () => {
    assert.match(app, /data-testid="operator-no-assigned-jobs"/);
    assert.match(app, /data-testid="empty-state-date-picker"/);
    assert.match(app, /onClick=\{handleRefresh\}/);
  });

  it('only activates from the explicit no-assigned-applications API result for operators', () => {
    assert.match(app, /raw\.emptyState === 'NO_ASSIGNED_APPLICATIONS'/);
    assert.match(app, /sessionRole\(\) === 'operator'/);
    assert.match(app, /if \(emptyMsg\) \{[\s\S]*?setSelectedCandidateId\(null\)/);
  });
});
