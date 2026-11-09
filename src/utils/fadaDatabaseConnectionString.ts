export function getFadaDatabaseConnectionString(env: Record<string, string | undefined>): string {
  const connectionString = env.DB2_URL || env.DATABASE_URL_2 || env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('FADA requires DB2_URL, DATABASE_URL_2, or DATABASE_URL to be configured.');
  }
  return connectionString;
}
