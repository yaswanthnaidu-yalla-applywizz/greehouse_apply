/** Node rejects response header values outside visible ASCII (ERR_INVALID_CHAR). */
export function sanitizeHttpHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[^\t\x20-\x7E]/g, '-');
}
