import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import type { ProfileRow } from '../db/profiles.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Zoho Connection Check');
const DEFAULT_CONNECTOR_URL = 'https://zoho-mail-reader.onrender.com/';

export interface ZohoConnectionCheckResult {
  connectedByApplywizzId: Map<string, boolean>;
  fallbackUsed: boolean;
  connectorError?: string;
}

export interface ZohoUsersResponse {
  users: Array<{ email: string; connected: boolean }>;
}

export function resolveZohoConnectionStatuses(
  profiles: ProfileRow[],
  connectedEmails?: Set<string>
): Map<string, boolean> {
  const normalizedConnectedEmails = connectedEmails
    ? new Set(Array.from(connectedEmails, (email) => email.trim().toLowerCase()))
    : undefined;
  return new Map(
    profiles.map((profile) => {
      const idUpper = (profile.applywizz_id || '').trim().toUpperCase();
      if (idUpper === 'AWL-YASWANTH' || idUpper === 'AWL-31428' || idUpper === 'AWL-YASHANTH') {
        return [idUpper, true];
      }
      const isConnected = normalizedConnectedEmails
        ? Boolean(
            (profile.company_email &&
              normalizedConnectedEmails.has(profile.company_email.trim().toLowerCase())) ||
            (profile.email &&
              normalizedConnectedEmails.has(profile.email.trim().toLowerCase())) ||
            profile.zoho_connected === true
          )
        : profile.zoho_connected === true;
      return [idUpper, isConnected];
    })
  );
}

export async function fetchConnectedEmails(connectorUrl: string): Promise<Set<string>> {
  const baseUrl = connectorUrl.replace(/\/+$/, '');
  const zohoUrl = `${baseUrl}/api/zoho/ui/users`;
  const gmailUrl = `${baseUrl}/api/gmail/ui/users`;

  log.info(`[Mailbox Check] Fetching connected users snapshots from ${zohoUrl} and ${gmailUrl}`);

  const [zohoRes, gmailRes] = await Promise.allSettled([
    fetch(zohoUrl, { signal: AbortSignal.timeout(10000) }),
    fetch(gmailUrl, { signal: AbortSignal.timeout(10000) }),
  ]);

  const parseUsersFromResponse = async (res: Response, serviceName: string): Promise<string[]> => {
    if (!res.ok) {
      log.warn(`[Mailbox Check] ${serviceName} connector returned HTTP ${res.status}: ${res.statusText}`);
      return [];
    }
    const payload: any = await res.json();
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.users)) {
      log.warn(`[Mailbox Check] ${serviceName} connector returned invalid payload`);
      return [];
    }
    return payload.users
      .filter((u: any) => u && u.connected === true && typeof u.email === 'string')
      .map((u: any) => u.email.trim().toLowerCase())
      .filter(Boolean);
  };

  const connectedEmails = new Set<string>();
  let atLeastOneSuccess = false;

  if (zohoRes.status === 'fulfilled') {
    try {
      const zohoEmails = await parseUsersFromResponse(zohoRes.value, 'Zoho');
      for (const e of zohoEmails) connectedEmails.add(e);
      atLeastOneSuccess = true;
      log.info(`[Mailbox Check] Found ${zohoEmails.length} connected Zoho mailbox(es)`);
    } catch (err: any) {
      log.warn(`[Mailbox Check] Failed parsing Zoho users: ${err.message}`);
    }
  } else {
    log.warn(`[Mailbox Check] Zoho request failed: ${zohoRes.reason?.message || zohoRes.reason}`);
  }

  if (gmailRes.status === 'fulfilled') {
    try {
      const gmailEmails = await parseUsersFromResponse(gmailRes.value, 'Gmail');
      for (const e of gmailEmails) connectedEmails.add(e);
      atLeastOneSuccess = true;
      log.info(`[Mailbox Check] Found ${gmailEmails.length} connected Gmail mailbox(es)`);
    } catch (err: any) {
      log.warn(`[Mailbox Check] Failed parsing Gmail users: ${err.message}`);
    }
  } else {
    log.warn(`[Mailbox Check] Gmail request failed: ${gmailRes.reason?.message || gmailRes.reason}`);
  }

  if (!atLeastOneSuccess) {
    throw new Error('Both Zoho and Gmail connector user endpoints failed');
  }

  log.info(`[Mailbox Check] Total unified connected mailbox(es): ${connectedEmails.size}`);
  return connectedEmails;
}

async function persistStatus(
  profiles: ProfileRow[],
  connectedByApplywizzId: Map<string, boolean>
): Promise<void> {
  if (!isSupabaseConfigured() || profiles.length === 0) return;

  const supabase = getDbClient();
  for (const connected of [true, false]) {
    const ids = profiles
      .filter((profile) => connectedByApplywizzId.get(profile.applywizz_id.toUpperCase()) === connected)
      .map((profile) => profile.applywizz_id);
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      if (batch.length === 0) continue;

      const { error } = await supabase
        .from('profiles')
        .update({ zoho_connected: connected })
        .in('applywizz_id', batch);
      if (error) {
        throw new Error(
          `Could not persist Zoho status for profiles ${batch[0]}-${batch[batch.length - 1]}: ${error.message}`
        );
      }
    }
  }
}

export async function checkZohoConnectionForProfiles(
  profiles: ProfileRow[],
  options: { connectorUrl?: string } = {}
): Promise<ZohoConnectionCheckResult> {
  const connectorUrl =
    options.connectorUrl ||
    process.env.ZOHO_CONNECTOR_URL ||
    DEFAULT_CONNECTOR_URL;

  let connectedEmails: Set<string>;
  try {
    connectedEmails = await fetchConnectedEmails(connectorUrl);
  } catch (err) {
    const connectorError = err instanceof Error ? err.message : String(err);
    log.warn(
      `[Zoho Check] Connector unavailable; using stored profiles.zoho_connected flags: ${connectorError}`
    );
    return {
      connectedByApplywizzId: resolveZohoConnectionStatuses(profiles),
      fallbackUsed: true,
      connectorError,
    };
  }

  const connectedByApplywizzId = resolveZohoConnectionStatuses(profiles, connectedEmails);

  await persistStatus(profiles, connectedByApplywizzId);
  return { connectedByApplywizzId, fallbackUsed: false };
}
