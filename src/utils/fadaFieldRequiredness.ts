export function getPersistedRequiredness(field: { isRequired?: unknown; required?: unknown }): boolean {
  if (typeof field.isRequired === 'boolean') return field.isRequired;
  return typeof field.required === 'boolean' ? field.required : false;
}
