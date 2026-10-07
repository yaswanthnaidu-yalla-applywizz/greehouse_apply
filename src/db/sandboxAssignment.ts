export const SANDBOX_CA_EMAIL = 'yaswanthnaiduyalla@applywizz.ai';

export function getSandboxCaEmail(): string | null {
  return process.env.SANDBOX === 'true' || process.env.SANDBOX === '1'
    ? SANDBOX_CA_EMAIL
    : null;
}

export function resolveAssignedCaEmail(caEmail?: string | null): string | null {
  return getSandboxCaEmail() || caEmail || null;
}
