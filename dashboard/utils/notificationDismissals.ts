/**
 * @fileoverview Browser LocalStorage Utility for Notification Dismissals.
 *
 * Persists dismissed notification IDs client-side so dismissal state survives
 * browser refresh without requiring server disk mutations.
 */

export const STORAGE_KEY = 'applywizz_dismissed_notifications';

function isStorageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

/**
 * Retrieves the set of dismissed notification IDs stored in localStorage.
 * Safe for SSR / environments where localStorage is unavailable.
 */
export function getDismissedNotificationIds(): Set<string> {
  if (!isStorageAvailable()) {
    return new Set<string>();
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set<string>(parsed.map(String));
    }
  } catch {
    // Graceful fallback for corrupted data
  }
  return new Set<string>();
}

/**
 * Adds a notification ID to the dismissed list in localStorage.
 */
export function dismissNotificationId(id: string): void {
  if (!isStorageAvailable() || !id) return;
  const set = getDismissedNotificationIds();
  set.add(id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Handle storage quota / write errors silently
  }
}

/**
 * Adds multiple notification IDs to the dismissed list in localStorage.
 */
export function dismissAllNotificationIds(ids: string[]): void {
  if (!isStorageAvailable() || !ids || ids.length === 0) return;
  const set = getDismissedNotificationIds();
  for (const id of ids) {
    if (id) set.add(id);
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Handle storage quota / write errors silently
  }
}

/**
 * Filters out any notifications that have been marked as dismissed.
 */
export function filterActiveNotifications<T extends { id: string }>(items: T[]): T[] {
  if (!Array.isArray(items)) return [];
  const dismissed = getDismissedNotificationIds();
  if (dismissed.size === 0) return items;
  return items.filter((item) => !dismissed.has(item.id));
}
