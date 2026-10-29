/**
 * @fileoverview DataImpulse Geo-Targeted Residential Proxy Configuration for Ashby Submissions.
 */

import { randomBytes } from 'node:crypto';
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

const COUNTRY_CODE_MAP: Record<string, string> = {
  'united states': 'us',
  usa: 'us',
  us: 'us',
  canada: 'ca',
  ca: 'ca',
  'united kingdom': 'gb',
  uk: 'gb',
  gb: 'gb',
  australia: 'au',
  au: 'au',
  germany: 'de',
  de: 'de',
  france: 'fr',
  fr: 'fr',
  india: 'in',
  in: 'in',
};

/**
 * Normalizes country strings to ISO 2-letter country codes for DataImpulse.
 */
export function parseCountryCode(country?: string | null): string {
  if (!country || typeof country !== 'string') return 'us';
  const clean = country.trim().toLowerCase();
  return COUNTRY_CODE_MAP[clean] || 'us';
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

  const countryCode = parseCountryCode(profile.country || (profile as any).country_code);
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
