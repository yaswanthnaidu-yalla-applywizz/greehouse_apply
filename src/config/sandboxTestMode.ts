import { isIP } from 'node:net';
import { parse as parsePostgresConnectionString } from 'pg-connection-string';

export const isSandboxMode = (): boolean => process.env.SANDBOX === 'true' || process.env.SANDBOX === '1';
const testModeEnabled = (): boolean => process.env.SANDBOX_TEST_MODE === 'true' || process.env.SANDBOX_TEST_MODE === '1';

const sandboxDatabaseError = (): Error => new Error('Sandbox test mode requires a local applywizz_sandbox database URL.');

function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const [addressPart, prefix, ...extra] = address.toLowerCase().split('/');
  const normalized = addressPart.replace(/%[^%]+$/, '');
  const ipVersion = isIP(normalized);
  if (
    extra.length > 0 ||
    (prefix !== undefined && (!/^\d+$/.test(prefix) || ipVersion === 0 || Number(prefix) > (ipVersion === 4 ? 32 : 128)))
  ) return false;
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return isLoopbackAddress(normalized.slice('::ffff:'.length));
  if (ipVersion !== 4) return false;
  return Number(normalized.split('.')[0]) === 127;
}

export function assertSandboxTestDatabaseIdentity(connectionString: string): void {
  try {
    const config = parsePostgresConnectionString(connectionString);
    const url = new URL(connectionString);
    const params = url.searchParams;
    const authorityHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const effectiveHost = config.host?.toLowerCase().replace(/^\[|\]$/g, '');
    const authorityPort = url.port || '5432';

    if (
      params.has('hostaddr') ||
      (params.has('host') && params.get('host')?.toLowerCase() !== authorityHost) ||
      (params.has('port') && params.get('port') !== authorityPort) ||
      (params.has('dbname') && params.get('dbname') !== config.database) ||
      (params.has('database') && params.get('database') !== config.database) ||
      !effectiveHost ||
      !isLoopbackAddress(effectiveHost) && effectiveHost !== 'localhost' ||
      config.database !== 'applywizz_sandbox'
    ) {
      throw sandboxDatabaseError();
    }
  } catch {
    throw sandboxDatabaseError();
  }
}

export function assertSandboxTestDatabaseConnection(identity: {
  database: string | null | undefined;
  serverAddress: string | null | undefined;
  remoteAddress: string | null | undefined;
}): void {
  if (
    identity.database !== 'applywizz_sandbox' ||
    !isLoopbackAddress(identity.serverAddress) ||
    !isLoopbackAddress(identity.remoteAddress)
  ) {
    throw sandboxDatabaseError();
  }
}

export function isSandboxTestMode(): boolean {
  return isSandboxMode() && testModeEnabled();
}

export function assertSandboxTestModeConfiguration(): void {
  if (testModeEnabled() && !isSandboxMode()) {
    throw new Error('SANDBOX_TEST_MODE requires SANDBOX=true.');
  }
  if (isSandboxTestMode()) {
    assertSandboxTestDatabaseIdentity(
      process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/applywizz_sandbox'
    );
  }
}
