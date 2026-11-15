/**
 * @fileoverview Reset & Recreation script for Sandbox Database (applywizz_sandbox).
 */

import pg from 'pg';
import { createLogger } from '../src/utils/logger.js';
import { resetSandboxDatabase } from './resetSandboxDbCore.js';

const { Client } = pg;
const log = createLogger('SandboxFresh');

void resetSandboxDatabase({
  testMode: process.env.SANDBOX_TEST_MODE === 'true' || process.env.SANDBOX_TEST_MODE === '1',
  databaseUrl: process.env.DATABASE_URL,
  createClient: (connectionString) => new Client({ connectionString }),
  log,
  exit: (code) => process.exit(code),
});
