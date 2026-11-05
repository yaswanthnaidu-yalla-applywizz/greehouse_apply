export type LiveResolutionExecution = { kind: 'live'; allowTier5: true; allowWrites: true };
export type ShadowResolutionExecution = { kind: 'shadow'; allowTier5: false; allowWrites: false };
export type ResolutionExecution = LiveResolutionExecution | ShadowResolutionExecution;
export type ResolutionDecision =
  | { kind: 'resolved'; value: string; provenance?: unknown }
  | { kind: 'tier5_required' }
  | { kind: 'unresolved'; reason: string };
