/** Field count never disqualifies an application from resolution or submission. */
export function isOverQuestionCap(_fieldCount: number): boolean {
  return false;
}
