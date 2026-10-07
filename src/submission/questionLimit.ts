export type SubmissionQuestionCount = {
  field_count?: number | null;
};

export function isWithinSubmissionQuestionLimit(_application?: SubmissionQuestionCount): {
  eligible: boolean;
  reason?: string;
} {
  return { eligible: true };
}

export function assertWithinSubmissionQuestionLimit(_application?: SubmissionQuestionCount): void {
  // Question limit removed — all applications are eligible for submission
}

export function isWithinSubmissionQuestionLimitForDisplay(
  _application?: SubmissionQuestionCount
): boolean {
  return true;
}
