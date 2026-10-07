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

interface ZohoUsersResponse {
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
    profiles.map((profile) => [
      profile.applywizz_id.toUpperCase(),
      normalizedConnectedEmails
        ? Boolean(
            profile.company_email &&
              normalizedConnectedEmails.has(profile.company_email.trim().toLowerCase())
          )
        : profile.zoho_connected === true,
    ])
  );
}

async function fetchConnectedEmails(connectorUrl: string): Promise<Set<string>> {
  const url = `${connectorUrl.replace(/\/+$/, '')}/api/zoho/ui/users`;
  log.info(`[Zoho Check] Fetching connected users snapshot from ${url}`);

  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`Zoho connector returned HTTP ${response.status}: ${response.statusText}`);
  }

  const payload: unknown = await response.json();
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as ZohoUsersResponse).users)
  ) {
    throw new Error('Zoho connector returned an invalid users response');
  }

  const users = (payload as ZohoUsersResponse).users;
  if (
    users.some(
      (user) =>
        !user ||
        typeof user.email !== 'string' ||
        typeof user.connected !== 'boolean'
    )
  ) {
    throw new Error('Zoho connector returned an invalid user entry');
  }

  const connectedEmails = new Set(
    users
      .filter((user) => user.connected)
      .map((user) => user.email.trim().toLowerCase())
      .filter(Boolean)
  );
  log.info(
    `[Zoho Check] Snapshot contains ${connectedEmails.size} connected email(s) out of ${users.length} user(s)`
  );
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
