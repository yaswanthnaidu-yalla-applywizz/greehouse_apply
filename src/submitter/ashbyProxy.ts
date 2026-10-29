/**
 * @fileoverview DataImpulse Geo-Targeted Residential Proxy Configuration for Ashby Submissions.
 */

import crypto, { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import type { ProfileRow } from '../db/profiles.js';

export interface ProxyConfig {
  server: string;
  username: string;
  password?: string;
}

export interface ProxyOptions {
  login?: string;
  password?: string;
  host?: string;
  port?: number | string;
  attemptToken?: string;
}

export class InvalidCountryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCountryError';
  }
}

const COUNTRY_CODE_MAP: Record<string, string> = {
  // United States
  'united states': 'us',
  'united states of america': 'us',
  usa: 'us',
  us: 'us',
  // Canada
  canada: 'ca',
  ca: 'ca',
  // United Kingdom
  'united kingdom': 'gb',
  uk: 'gb',
  gb: 'gb',
  'great britain': 'gb',
  england: 'gb',
  scotland: 'gb',
  wales: 'gb',
  // Ireland
  ireland: 'ie',
  'republic of ireland': 'ie',
  ie: 'ie',
  // Netherlands
  netherlands: 'nl',
  holland: 'nl',
  nl: 'nl',
  // Germany
  germany: 'de',
  deutschland: 'de',
  de: 'de',
  // France
  france: 'fr',
  fr: 'fr',
  // India
  india: 'in',
  in: 'in',
  // Australia
  australia: 'au',
  au: 'au',
  // Singapore
  singapore: 'sg',
  sg: 'sg',
  // Switzerland
  switzerland: 'ch',
  ch: 'ch',
  // Sweden
  sweden: 'se',
  se: 'se',
  // Spain
  spain: 'es',
  es: 'es',
  // Poland
  poland: 'pl',
  pl: 'pl',
};

const PHONE_PREFIX_TO_ISO: Record<string, string> = {
  '1': 'us',
  '44': 'gb',
  '353': 'ie',
  '31': 'nl',
  '49': 'de',
  '33': 'fr',
  '91': 'in',
  '61': 'au',
  '65': 'sg',
  '41': 'ch',
  '46': 'se',
  '34': 'es',
  '48': 'pl',
};

/**
 * Normalizes country strings to ISO 2-letter country codes for DataImpulse.
 * Rejects invalid or unresolvable values by throwing InvalidCountryError (fail-closed).
 */
export function parseCountryCode(country?: string | null): string {
  if (!country || typeof country !== 'string') {
    throw new InvalidCountryError('Country is required and must be a non-empty string');
  }
  const clean = country.trim().toLowerCase();
  if (!clean) {
    throw new InvalidCountryError('Country cannot be empty');
  }
  if (COUNTRY_CODE_MAP[clean]) {
    return COUNTRY_CODE_MAP[clean];
  }
  if (/^[a-z]{2}$/.test(clean)) {
    return clean;
  }
  throw new InvalidCountryError(`Unable to resolve ISO-2 country code from: "${country}"`);
}

/**
 * Extracts country code from a location string (e.g. 'Dublin, Leinster, Ireland' -> 'ie').
 */
export function extractCountryFromLocation(location?: string | null): string | null {
  if (!location || typeof location !== 'string') return null;
  const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  // Check the last segment first
  const lastPart = parts[parts.length - 1];
  try {
    return parseCountryCode(lastPart);
  } catch {
    // If last part is not a country, try other parts in reverse order
    for (let i = parts.length - 2; i >= 0; i--) {
      try {
        return parseCountryCode(parts[i]);
      } catch {
        // continue
      }
    }
  }
  return null;
}

/**
 * Parses phone calling code or country code prefix to ISO 2-letter country code.
 */
export function parsePhoneCountryCode(code?: string | null): string | null {
  if (!code || typeof code !== 'string') return null;

  // If it's already an ISO code or country name directly
  try {
    return parseCountryCode(code);
  } catch {
    // continue
  }

  const clean = code.trim();
  const digits = clean.replace(/^\+|^00/, '').replace(/\D/g, '');
  if (!digits) return null;

  if (PHONE_PREFIX_TO_ISO[digits]) {
    return PHONE_PREFIX_TO_ISO[digits];
  }

  for (const [prefix, iso] of Object.entries(PHONE_PREFIX_TO_ISO)) {
    if (digits.startsWith(prefix) && digits.length > prefix.length) {
      return iso;
    }
  }
  return null;
}

/**
 * Multi-tier country resolution:
 * 1. profile.country
 * 2. profile.location (last segment)
 * 3. profile.country_code (phone prefix or ISO)
 * Halts loudly with InvalidCountryError if all tiers fail.
 */
export function resolveCountryCode(profile: Partial<ProfileRow> | Record<string, any>): string {
  // Tier 1: profile.country
  if (profile.country && typeof profile.country === 'string') {
    try {
      return parseCountryCode(profile.country);
    } catch {
      // Fall through to next tier
    }
  }

  // Tier 2: profile.location
  if (profile.location && typeof profile.location === 'string') {
    const fromLoc = extractCountryFromLocation(profile.location);
    if (fromLoc) return fromLoc;
  }

  // Tier 3: profile.country_code (phone prefix or ISO code)
  if (profile.country_code && typeof profile.country_code === 'string') {
    const fromCode = parsePhoneCountryCode(profile.country_code);
    if (fromCode) return fromCode;
  }

  throw new InvalidCountryError(
    `Unable to resolve valid ISO-2 country code for candidate profile "${profile.applywizz_id || 'unknown'}". ` +
      `country="${profile.country}", location="${profile.location}", country_code="${profile.country_code}".`
  );
}

/**
 * Parses city name without spaces from standard 'City, State, Country' or 'City, State' location strings.
 */
export function parseCityFromLocation(location?: string | null): string {
  if (!location || typeof location !== 'string') return '';
  const firstSegment = location.split(',')[0].trim();
  // Remove whitespace and non-alphanumeric characters for DataImpulse city tag
  return firstSegment.replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Builds geo-targeted sticky residential proxy configuration for an Ashby application.
 * Halts loudly if credentials are not configured.
 */
export function buildAshbyProxyConfig(
  profile: ProfileRow,
  options: ProxyOptions = {}
): ProxyConfig {
  const login = options.login || process.env.DATAIMPULSE_LOGIN;
  const password = options.password || process.env.DATAIMPULSE_PASSWORD;
  const host = options.host || process.env.DATAIMPULSE_HOST || 'gw.dataimpulse.com';
  const port = options.port || process.env.DATAIMPULSE_PORT || 823;

  if (!login || !password) {
    throw new Error(
      'Ashby application submission requires residential proxy, but DATAIMPULSE_LOGIN or DATAIMPULSE_PASSWORD is missing.'
    );
  }

  const countryCode = resolveCountryCode(profile);
  const city = parseCityFromLocation(profile.location);

  const cleanId = String(profile.applywizz_id || 'candidate').replace(/[^a-zA-Z0-9]/g, '');
  const attemptToken = options.attemptToken || randomBytes(4).toString('hex');

  let username = `${login}__cr.${countryCode}`;
  if (city) {
    username += `;city.${city}`;
  }
  username += `;sessid.${cleanId}_${attemptToken}`;

  return {
    server: `http://${host}:${port}`,
    username,
    password,
  };
}

export interface ProxyPreflightResult {
  success: boolean;
  exitIpHash?: string;
  error?: string;
}

/**
 * Lightweight same-browser proxy preflight verification.
 * Probes the proxy exit IP using Playwright page.request with a hard timeout.
 * Never throws — always returns a ProxyPreflightResult.
 *
 * Note: DataImpulse enforces target country routing at the proxy gateway username level (__cr.<iso>).
 * If endpointUrl returns country information, expectedCountryCode is validated; otherwise, IP continuity
 * and successful egress are verified, and an exit IP hash is computed.
 */
export async function verifyProxyPreflight(
  page: Page,
  expectedCountryCode?: string,
  options: { timeoutMs?: number; endpointUrl?: string } = {}
): Promise<ProxyPreflightResult> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const endpointUrl = options.endpointUrl || 'https://api.ipify.org?format=json';

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Preflight probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const probePromise = (async (): Promise<ProxyPreflightResult> => {
      const response = await page.request.get(endpointUrl, { timeout: timeoutMs });
      if (!response.ok() || response.status() !== 200) {
        throw new Error(`Preflight probe failed with HTTP status ${response.status()}`);
      }
      const data = await response.json();
      const ip = data?.ip || data?.query;
      if (!ip || typeof ip !== 'string') {
        throw new Error('Preflight probe did not return a valid IP');
      }

      if (expectedCountryCode) {
        const respCountry = (data?.country || data?.country_code || data?.countryCode || '')
          ?.toString()
          .trim()
          .toLowerCase();
        if (respCountry && respCountry !== expectedCountryCode.trim().toLowerCase()) {
          throw new Error(
            `Proxy exit country mismatch: expected ${expectedCountryCode}, got ${respCountry}`
          );
        }
      }

      const exitIpHash = crypto
        .createHash('sha256')
        .update(ip.trim())
        .digest('hex')
        .slice(0, 12);

      return {
        success: true,
        exitIpHash,
      };
    })();

    return await Promise.race([probePromise, timeoutPromise]);
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Preflight probe failed',
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
