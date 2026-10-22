/**
 * @fileoverview CSV Ingestion, URL Normalization, and Shortlink Resolution for Greenhouse & Ashby URLs.
 *
 * Implements Branch 1 stream-parsing of candidate-job CSV inputs, tracking parameter stripping,
 * fast HTTP resolution of `grnh.se` shortlinks, and deduplication into canonical job URLs.
 */

import fs from 'fs';
import * as fastCsv from 'fast-csv';
import { createLogger, haltWithDevAlert } from '../utils/logger.js';
import { isPipelineCompactLogging } from '../utils/pipelineLogging.js';
import { isAshbyUrl } from './atsDetector.js';

const log = createLogger('Csv Deduplicator');

/**
 * Returns 'ashby' if URL matches Ashby patterns, else 'greenhouse'.
 */
export function atsFromUrl(url: string): 'greenhouse' | 'ashby' {
  return isAshbyUrl(url) ? 'ashby' : 'greenhouse';
}

/**
 * Options configuring the CSV deduplication and shortlink resolution pipeline.
 */
export interface DeduplicatorOptions {
  /**
   * Maximum concurrent HTTP requests when resolving `grnh.se` shortlinks.
   * @default 25
   */
  concurrency?: number;

  /**
   * Whether to resolve `grnh.se` shortlinks to canonical Greenhouse URLs.
   * @default true
   */
  resolveShortlinks?: boolean;

  /**
   * Maximum number of rows to parse from CSV (useful for sample testing).
   * @default undefined (parses entire file)
   */
  limit?: number;

  /**
   * Optional logger callback for progress updates.
   */
  onProgress?: (stats: { parsedRows: number; uniqueUrls: number; resolvedShortlinks: number }) => void;
}

/**
 * Known marketing and analytics query parameter keys to strip from URLs.
 */
const TRACKING_PARAM_REGEX = /^(gh_src|utm_source|utm_medium|utm_campaign|utm_term|utm_content|ref|source|src|fbclid|gclid|_ga|mc_cid|mc_eid)$/i;

/**
 * Normalizes an Ashby job URL by stripping tracking parameters,
 * while preserving required query params such as ashby_jid.
 */
export function normalizeAshbyUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return '';

  try {
    const urlObj = new URL(trimmed);
    urlObj.protocol = 'https:';
    urlObj.hostname = urlObj.hostname.toLowerCase();
    urlObj.hash = '';

    const keysToDelete: string[] = [];
    urlObj.searchParams.forEach((_, key) => {
      if (TRACKING_PARAM_REGEX.test(key)) {
        keysToDelete.push(key);
      }
    });
    for (const key of keysToDelete) {
      urlObj.searchParams.delete(key);
    }

    let pathname = urlObj.pathname;
    while (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    urlObj.pathname = pathname;

    return urlObj.toString();
  } catch {
    return trimmed;
  }
}

/**
 * Normalizes a Greenhouse job URL by removing tracking query parameters, trimming whitespace,
 * normalizing protocol/hostname, and removing trailing slashes while preserving necessary
 * query arguments (e.g., `token` for embed pages).
 */
export function normalizeGreenhouseUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }

  const trimmed = rawUrl.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return '';
  }

  try {
    const urlObj = new URL(trimmed);

    // Force https protocol
    urlObj.protocol = 'https:';

    // Lowercase hostname
    urlObj.hostname = urlObj.hostname.toLowerCase();

    // Remove hash/fragment
    urlObj.hash = '';

    // Collect keys to delete
    const keysToDelete: string[] = [];
    urlObj.searchParams.forEach((_, key) => {
      if (TRACKING_PARAM_REGEX.test(key)) {
        keysToDelete.push(key);
      }
    });

    for (const key of keysToDelete) {
      urlObj.searchParams.delete(key);
    }

    // Standardize pathname (strip trailing slash unless path is root '/')
    if (urlObj.pathname.length > 1 && urlObj.pathname.endsWith('/')) {
      urlObj.pathname = urlObj.pathname.slice(0, -1);
    }

    // Return sanitized URL string
    return urlObj.toString();
  } catch {
    // If URL parsing fails, return sanitized string fallback
    return trimmed.replace(/[?&]gh_src=[^&]+/i, '').replace(/[?&]utm_[^&]+/i, '');
  }
}

/**
 * In-memory cache for resolved shortlink targets to eliminate redundant network calls.
 */
const shortlinkCache = new Map<string, string>();

/**
 * Resolves a single `grnh.se` shortlink to its target canonical Greenhouse URL
 * using HTTP HEAD (with GET fallback and redirect following).
 */
export async function resolveShortlink(shortUrl: string): Promise<string> {
  const normalizedInput = normalizeGreenhouseUrl(shortUrl);
  if (!normalizedInput) {
    return shortUrl;
  }

  if (shortlinkCache.has(normalizedInput)) {
    return shortlinkCache.get(normalizedInput)!;
  }

  try {
    const response = await fetch(normalizedInput, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(3500),
    });

    const locationHeader = response.headers.get('location');
    if (locationHeader) {
      const canonical = normalizeGreenhouseUrl(locationHeader);
      shortlinkCache.set(normalizedInput, canonical);
      return canonical;
    }

    if (response.url && response.url !== normalizedInput) {
      const canonical = normalizeGreenhouseUrl(response.url);
      shortlinkCache.set(normalizedInput, canonical);
      return canonical;
    }

    shortlinkCache.set(normalizedInput, normalizedInput);
    return normalizedInput;
  } catch {
    shortlinkCache.set(normalizedInput, normalizedInput);
    return normalizedInput;
  }
}

/**
 * Resolves an array of `grnh.se` shortlinks concurrently with a bounded pool limit.
 */
export async function resolveShortlinksBatch(
  shortUrls: string[],
  concurrency = 25
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const queue = [...shortUrls];
  const workers: Promise<void>[] = [];

  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) break;
      const canonical = await resolveShortlink(url);
      results.set(url, canonical);
    }
  };

  const poolSize = Math.min(concurrency, Math.max(1, shortUrls.length));
  for (let i = 0; i < poolSize; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

/**
 * Stream-parses the input CSV file, extracts the `url` column, normalizes URLs (Greenhouse or Ashby),
 * resolves `grnh.se` shortlinks to canonical URLs, and returns a deduplicated array of unique canonical URLs.
 */
export async function readAndDeduplicateUrls(
  csvPath: string,
  options: DeduplicatorOptions = {}
): Promise<string[]> {
  const {
    concurrency = 25,
    resolveShortlinks = true,
    limit,
    onProgress,
  } = options;

  if (!fs.existsSync(csvPath)) {
    throw new Error(`Input CSV file not found at path: "${csvPath}"`);
  }

  const rawUrlsSet = new Set<string>();
  const shortlinkSet = new Set<string>();
  let parsedRows = 0;

  const compact = isPipelineCompactLogging();

  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(csvPath);

    fastCsv
      .parseStream(stream, { headers: true, trim: true, ignoreEmpty: true })
      .on('error', (error) => {
        haltWithDevAlert(
          'CSV',
          'CSV parse failure — malformed CSV or zero valid rows parsed',
          error
        );
      })
      .on('data', (row: Record<string, string>) => {
        parsedRows++;

        // Case-insensitive column resolution for job URL
        const rawUrl = row.url || row.URL || row.Url || row.job_url || row['Job URL'] || '';
        if (rawUrl) {
          const isAshby = isAshbyUrl(rawUrl);
          const normalized = isAshby ? normalizeAshbyUrl(rawUrl) : normalizeGreenhouseUrl(rawUrl);
          if (normalized) {
            rawUrlsSet.add(normalized);
            if (!isAshby && normalized.includes('grnh.se')) {
              shortlinkSet.add(normalized);
            }
          }
        }

        if (limit && parsedRows >= limit) {
          stream.destroy();
          resolve();
        }

        if (parsedRows % 50000 === 0 && onProgress) {
          onProgress({
            parsedRows,
            uniqueUrls: rawUrlsSet.size,
            resolvedShortlinks: shortlinkCache.size,
          });
        }
      })
      .on('end', () => {
        resolve();
      });
  });

  if (parsedRows === 0) {
    haltWithDevAlert('CSV', 'CSV parse failure — malformed CSV or zero valid rows parsed');
  }

  const finalUrlsSet = new Set<string>();

  if (resolveShortlinks && shortlinkSet.size > 0) {
    const shortlinkList = Array.from(shortlinkSet);
    const resolvedMap = await resolveShortlinksBatch(shortlinkList, concurrency);

    for (const url of rawUrlsSet) {
      if (resolvedMap.has(url)) {
        const canonical = resolvedMap.get(url)!;
        if (canonical) finalUrlsSet.add(canonical);
      } else {
        finalUrlsSet.add(url);
      }
    }
  } else {
    for (const url of rawUrlsSet) {
      finalUrlsSet.add(url);
    }
  }

  const uniqueCanonicalUrls = Array.from(finalUrlsSet).filter(Boolean);
  if (uniqueCanonicalUrls.length === 0) {
    haltWithDevAlert('CSV', 'CSV parse failure — malformed CSV or zero valid rows parsed');
  }
  if (compact) {
    log.info(
      `[CSV Deduplicator] ingest rows=${parsedRows.toLocaleString()} raw_urls=${rawUrlsSet.size.toLocaleString()} shortlinks=${shortlinkSet.size.toLocaleString()} unique_canonical=${uniqueCanonicalUrls.length.toLocaleString()}`
    );
  } else {
    log.info(`[CSV Deduplicator] 📂 Stream-parsed: ${csvPath}`);
    log.info(
      `[CSV Deduplicator] 📊 Parsed ${parsedRows.toLocaleString()} rows. Found ${rawUrlsSet.size.toLocaleString()} distinct raw URLs.`
    );
    if (resolveShortlinks && shortlinkSet.size > 0) {
      log.info(
        `[CSV Deduplicator] 🔄 Resolved ${shortlinkSet.size.toLocaleString()} grnh.se shortlinks (concurrency: ${concurrency})`
      );
    }
    log.info(
      `[CSV Deduplicator] ✅ Deduplication complete. Total unique canonical URLs: ${uniqueCanonicalUrls.length.toLocaleString()}`
    );
  }

  return uniqueCanonicalUrls;
}
