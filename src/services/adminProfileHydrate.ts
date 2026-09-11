/**
 * Upserts minimal profile rows from CA work-history (admin / org-wide listing).
 */

import { upsertProfile } from '../db/profiles.js';
import {
  fetchAdminWorkHistoryForDate,
  getYesterdayIST,
} from './workHistoryClient.js';

export async function hydrateAdminProfilesFromWorkHistory(dateStr?: string): Promise<number> {
  const date = dateStr || getYesterdayIST();
  const whResult = await fetchAdminWorkHistoryForDate(date);
  let count = 0;

  for (const rec of whResult.records) {
    await upsertProfile({
      applywizz_id: rec.applywizzId,
      client_name: rec.clientName || rec.applywizzId,
      email: rec.clientEmail || null,
      company_email: rec.clientEmail || null,
    });
    count++;
  }

  return count;
}
