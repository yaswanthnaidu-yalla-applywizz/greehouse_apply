/**
 * @fileoverview Zoho Connected Candidates Allowlist Service.
 *
 * Lazy-loads `cache/zoho_connected_emails.json` on first call and caches in-memory.
 * Returns true if candidate's company email is in the allowlist OR if the allowlist
 * is empty/missing (safe fallback).
 */

import fs from 'fs';
import path from 'path';

let cachedAllowlist: Set<string> | null = null;
const ALLOWLIST_FILE_PATH = path.resolve(process.cwd(), 'cache', 'zoho_connected_emails.json');

/**
 * Loads the Zoho connected emails allowlist into memory from cache/zoho_connected_emails.json.
 */
function loadAllowlist(): Set<string> {
  if (cachedAllowlist !== null) {
    return cachedAllowlist;
  }

  try {
    if (fs.existsSync(ALLOWLIST_FILE_PATH)) {
      const raw = fs.readFileSync(ALLOWLIST_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        cachedAllowlist = new Set(
          parsed
            .filter((item): item is string => typeof item === 'string')
            .map((email) => email.trim().toLowerCase())
        );
        console.log(`[Zoho Allowlist] ✅ Loaded ${cachedAllowlist.size} connected emails on success.`);
        return cachedAllowlist;
      }
    }
  } catch (err: any) {
    console.warn(`[Zoho Allowlist] ⚠️ Error loading allowlist file: ${err.message}`);
  }

  console.log('[Zoho Allowlist] ⚠️ allowlist DISABLED if file missing (safe fallback enabled).');
  cachedAllowlist = new Set<string>();
  return cachedAllowlist;
}

/**
 * Checks whether the given company email is connected to Zoho Mail.
 * Returns true if email in allowlist OR allowlist is empty/missing (safe fallback).
 *
 * @param companyEmail - The candidate's company email address.
 * @returns boolean
 */
export function isZohoConnected(companyEmail?: string | null): boolean {
  const allowlist = loadAllowlist();

  // Safe fallback: if allowlist is empty or file missing, allow all
  if (allowlist.size === 0) {
    return true;
  }

  if (!companyEmail) {
    return false;
  }

  const normalized = companyEmail.trim().toLowerCase();
  return allowlist.has(normalized);
}

/**
 * Clears the in-memory allowlist cache (useful for testing or reloading).
 */
export function clearAllowlistCache(): void {
  cachedAllowlist = null;
}
