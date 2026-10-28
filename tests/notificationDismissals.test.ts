import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDismissedNotificationIds,
  dismissNotificationId,
  dismissAllNotificationIds,
  filterActiveNotifications,
} from '../dashboard/utils/notificationDismissals.js';

// Mock localStorage
const store: Record<string, string> = {};
(global as any).localStorage = {
  getItem: (key: string) => store[key] || null,
  setItem: (key: string, val: string) => { store[key] = val; },
  clear: () => { for (const k in store) delete store[k]; },
};

describe('Notification Dismissals Utility', () => {
  beforeEach(() => (global as any).localStorage.clear());

  test('dismisses and filters active notifications cleanly', () => {
    dismissNotificationId('notif-1');
    const items = [{ id: 'notif-1' }, { id: 'notif-2' }];
    const active = filterActiveNotifications(items);
    assert.deepEqual(active, [{ id: 'notif-2' }]);
  });

  test('dismissAllNotificationIds dismisses multiple notifications', () => {
    dismissAllNotificationIds(['notif-1', 'notif-2']);
    const items = [{ id: 'notif-1' }, { id: 'notif-2' }, { id: 'notif-3' }];
    const active = filterActiveNotifications(items);
    assert.deepEqual(active, [{ id: 'notif-3' }]);
  });
});
