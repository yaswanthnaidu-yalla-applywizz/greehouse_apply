/**
 * @fileoverview Reset & Recreation script for Sandbox Database (applywizz_sandbox).
 */

import pg from 'pg';
import { createLogger } from '../src/utils/logger.js';

const { Client } = pg;
const log = createLogger('SandboxFresh');

async function resetSandboxDatabase(): Promise<void> {
  const targetDb = 'applywizz_sandbox';
  const defaultUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/applywizz_sandbox';
  
  // Connect to the default 'postgres' database to perform drop/create
  const adminUrl = defaultUrl.replace(/\/[^/]+$/, '/postgres');
  
  log.info(`Connecting to ${adminUrl.replace(/:[^:@]+@/, ':****@')} to reset "${targetDb}"...`);
  const client = new Client({ connectionString: adminUrl });

  try {
    await client.connect();

    // Terminate existing connections to applywizz_sandbox
    await client.query(`
      SELECT pg_terminate_backend(pg_stat_activity.pid)
      FROM pg_stat_activity
      WHERE pg_stat_activity.datname = '${targetDb}'
        AND pid <> pg_backend_pid();
    `);

    // Drop database if exists
    await client.query(`DROP DATABASE IF EXISTS ${targetDb};`);
    log.info(`Dropped database "${targetDb}".`);

    // Recreate database
    await client.query(`CREATE DATABASE ${targetDb};`);
    log.info(`Created fresh database "${targetDb}".`);
  } catch (err: any) {
    log.error('Failed to reset sandbox database:', err.message || err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

resetSandboxDatabase();
