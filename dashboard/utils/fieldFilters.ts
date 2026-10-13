/**
 * @fileoverview Field filtering utilities for the TSX Operator Dashboard review carousel.
 */

import type { ResolvedField } from '../types.js';

/**
 * Returns true if a question should be included in the Operator Card Carousel review mode:
 * 1. Required Unresolved: isRequired === true && (source === 'unresolved' || resolvedByTier == null)
 * 2. Required Resolved with AI: isRequired === true && source === 'ai'
 * 3. Optional Resolved with AI: isRequired === false && source === 'ai'
 * 4. Any Manually Edited Field: isEdited === true || source === 'manual'
 *
 * All identity fields and non-AI profile/resume-resolved fields (Tiers 1-3) are excluded from the carousel.
 */
export function isActionableCarouselField(field: ResolvedField): boolean {
  if (!field) return false;

  // Retain any field the operator manually edited in this session or previously
  if (field.isEdited === true || field.source === 'manual') {
    return true;
  }

  const isReq = Boolean(field.isRequired || (field as any).required);
  const isAi = field.source === 'ai';
  const isUnresolved = field.source === 'unresolved' || field.resolvedByTier == null;

  // 1. Required unresolved
  if (isReq && isUnresolved) {
    return true;
  }

  // 2. Required resolved with AI
  if (isReq && isAi) {
    return true;
  }

  // 3. Optional resolved with AI
  if (!isReq && isAi) {
    return true;
  }

  return false;
}
