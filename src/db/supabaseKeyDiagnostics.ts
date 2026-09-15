/**
 * Safe diagnostics for Supabase URL + service key pairing (never logs the secret).
 */

export interface SupabaseKeyDiagnostics {
  urlHost: string;
  urlProjectRef: string | null;
  jwtRole: string | null;
  jwtRef: string | null;
  jwtIss: string | null;
  urlRefMatch: boolean | null;
  keyShape: 'jwt' | 'sb_secret' | 'other';
  keyHadSurroundingWhitespace: boolean;
  decodeNote: string | null;
  /** Single line for logs */
  summary: string;
}

function projectRefFromSupabaseUrl(url: string): { host: string; ref: string | null } {
  try {
    const host = new URL(url).hostname;
    const match = host.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return { host, ref: match ? match[1].toLowerCase() : null };
  } catch {
    return { host: '(invalid-url)', ref: null };
  }
}

function decodeJwtPayloadClaims(key: string): {
  role: string | null;
  ref: string | null;
  iss: string | null;
  note: string | null;
} {
  const parts = key.split('.');
  if (parts.length !== 3) {
    if (key.startsWith('sb_secret_')) {
      return {
        role: null,
        ref: null,
        iss: null,
        note: 'new-format sb_secret key (use legacy service_role JWT or upgrade client)',
      };
    }
    return { role: null, ref: null, iss: null, note: 'not-a-jwt' };
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      role?: string;
      ref?: string;
      iss?: string;
    };
    return {
      role: payload.role ?? null,
      ref: payload.ref ?? null,
      iss: payload.iss ?? null,
      note: null,
    };
  } catch {
    return { role: null, ref: null, iss: null, note: 'jwt-payload-parse-failed' };
  }
}

export function getSupabaseKeyDiagnostics(
  supabaseUrl: string,
  rawServiceKey: string
): SupabaseKeyDiagnostics {
  const trimmedKey = rawServiceKey.trim();
  const trimmedUrl = supabaseUrl.trim();
  const { host, ref: urlProjectRef } = projectRefFromSupabaseUrl(trimmedUrl);
  const claims = decodeJwtPayloadClaims(trimmedKey);

  let keyShape: SupabaseKeyDiagnostics['keyShape'] = 'other';
  if (trimmedKey.startsWith('sb_secret_')) keyShape = 'sb_secret';
  else if (trimmedKey.split('.').length === 3) keyShape = 'jwt';

  const jwtRefNorm = claims.ref?.toLowerCase() ?? null;
  const urlRefMatch =
    urlProjectRef && jwtRefNorm
      ? urlProjectRef === jwtRefNorm
      : urlProjectRef && !jwtRefNorm
        ? false
        : null;

  const parts = [
    `urlHost=${host}`,
    `urlProjectRef=${urlProjectRef ?? 'unknown'}`,
    `jwt.role=${claims.role ?? 'unknown'}`,
    `jwt.ref=${claims.ref ?? 'unknown'}`,
    claims.iss ? `jwt.iss=${claims.iss}` : null,
    `urlRefMatch=${urlRefMatch === null ? 'unknown' : String(urlRefMatch)}`,
    `keyShape=${keyShape}`,
    rawServiceKey !== trimmedKey ? 'keyHadWhitespace=true' : null,
    claims.note ? `note=${claims.note}` : null,
  ].filter(Boolean);

  return {
    urlHost: host,
    urlProjectRef,
    jwtRole: claims.role,
    jwtRef: claims.ref,
    jwtIss: claims.iss,
    urlRefMatch,
    keyShape,
    keyHadSurroundingWhitespace: rawServiceKey !== trimmedKey,
    decodeNote: claims.note,
    summary: parts.join(' | '),
  };
}
