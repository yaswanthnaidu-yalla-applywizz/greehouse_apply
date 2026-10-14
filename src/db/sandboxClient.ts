/**
 * @fileoverview PostgreSQL-backed Sandbox Client for Greenhouse Automation.
 *
 * Implements a Supabase-compatible PostgREST query builder API backed by node-postgres (pg),
 * a local filesystem-backed storage adapter, and schema migration & seeding utilities.
 */

import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { createLogger } from '../utils/logger.js';
import { SANDBOX_CA_EMAIL } from './sandboxAssignment.js';

const { Pool } = pg;
const log = createLogger('SandboxDB');

let poolInstance: pg.Pool | null = null;

export function getSandboxPool(): pg.Pool {
  if (poolInstance) return poolInstance;

  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/applywizz_sandbox';

  poolInstance = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
  });

  poolInstance.on('error', (err) => {
    log.error('Unexpected error on idle PostgreSQL sandbox client:', err);
  });

  return poolInstance;
}

export function isSandboxMode(): boolean {
  return process.env.SANDBOX === 'true' || process.env.SANDBOX === '1';
}

// -----------------------------------------------------------------------------
// Storage Adapter (Local File System)
// -----------------------------------------------------------------------------

function getStorageRootDir(): string {
  const custom = process.env.SANDBOX_STORAGE_DIR;
  const root = custom ? path.resolve(custom) : path.resolve(process.cwd(), 'storage_sandbox');
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}

export class SandboxStorageBucketClient {
  private bucket: string;

  constructor(bucket: string) {
    this.bucket = bucket;
    const bucketDir = path.join(getStorageRootDir(), bucket);
    if (!fs.existsSync(bucketDir)) {
      fs.mkdirSync(bucketDir, { recursive: true });
    }
  }

  private resolvePath(objectPath: string): string {
    const clean = objectPath.replace(/^\/+/, '');
    return path.join(getStorageRootDir(), this.bucket, clean);
  }

  async upload(objectPath: string, fileBody: Buffer | string, options?: { upsert?: boolean; contentType?: string }) {
    try {
      const fullPath = this.resolvePath(objectPath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(fullPath) && options?.upsert === false) {
        return { data: null, error: new Error('The resource already exists') };
      }

      const buffer = Buffer.isBuffer(fileBody) ? fileBody : Buffer.from(fileBody);
      fs.writeFileSync(fullPath, buffer);
      return { data: { path: objectPath }, error: null };
    } catch (err: any) {
      return { data: null, error: err };
    }
  }

  async download(objectPath: string) {
    try {
      const fullPath = this.resolvePath(objectPath);
      if (!fs.existsSync(fullPath)) {
        return { data: null, error: new Error('Object not found') };
      }
      const data = fs.readFileSync(fullPath);
      return { data: new Blob([data]), error: null };
    } catch (err: any) {
      return { data: null, error: err };
    }
  }

  async createSignedUrl(objectPath: string, _expiresIn: number) {
    // In local sandbox, point to local file path or sandbox asset route
    return {
      data: {
        signedUrl: `/api/sandbox/storage/${this.bucket}/${objectPath.replace(/^\/+/, '')}`,
      },
      error: null,
    };
  }

  async getPublicUrl(objectPath: string) {
    return {
      data: {
        publicUrl: `/api/sandbox/storage/${this.bucket}/${objectPath.replace(/^\/+/, '')}`,
      },
    };
  }

  async list(prefix: string = '', options?: { limit?: number; offset?: number; search?: string }) {
    try {
      const targetDir = path.join(getStorageRootDir(), this.bucket, prefix.replace(/^\/+/, ''));
      if (!fs.existsSync(targetDir)) {
        return { data: [], error: null };
      }
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      let files = entries
        .filter((e) => e.isFile())
        .map((e) => ({
          name: e.name,
          id: e.name,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString(),
          metadata: { size: 1024 },
        }));

      if (options?.search) {
        files = files.filter((f) => f.name.includes(options.search!));
      }
      if (options?.limit) {
        files = files.slice(options.offset || 0, (options.offset || 0) + options.limit);
      }
      return { data: files, error: null };
    } catch (err: any) {
      return { data: [], error: err };
    }
  }

  async remove(paths: string[]) {
    try {
      for (const p of paths) {
        const fullPath = this.resolvePath(p);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }
      return { data: paths.map((p) => ({ name: p })), error: null };
    } catch (err: any) {
      return { data: null, error: err };
    }
  }

  async move(fromPath: string, toPath: string) {
    try {
      const src = this.resolvePath(fromPath);
      const dest = this.resolvePath(toPath);
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
      }
      return { data: { message: 'Successfully moved' }, error: null };
    } catch (err: any) {
      return { data: null, error: err };
    }
  }
}

export class SandboxStorageClient {
  from(bucket: string): SandboxStorageBucketClient {
    return new SandboxStorageBucketClient(bucket);
  }

  async listBuckets() {
    return {
      data: [
        { id: 'resumes', name: 'resumes' },
        { id: 'proofs_web', name: 'proofs_web' },
        { id: 'proofs_failed', name: 'proofs_failed' },
        { id: 'proofs_mail', name: 'proofs_mail' },
        { id: 'csv_uploads', name: 'csv_uploads' },
      ],
      error: null,
    };
  }

  async createBucket(bucket: string) {
    const dir = path.join(getStorageRootDir(), bucket);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return { data: { name: bucket }, error: null };
  }
}

// -----------------------------------------------------------------------------
// PostgREST Query Builder Simulation for pg
// -----------------------------------------------------------------------------

type FilterCondition = {
  column: string;
  op: '=' | '!=' | 'IN' | 'NOT IN' | 'IS' | 'IS NOT' | 'LIKE' | 'ILIKE' | '>' | '<' | '>=' | '<=';
  value: any;
};

export class SandboxQueryBuilder {
  private table: string;
  private selectColumns: string = '*';
  private conditions: FilterCondition[] = [];
  private orderColumn?: string;
  private orderAscending: boolean = true;
  private limitCount?: number;
  private offsetCount?: number;
  private mutationType?: 'insert' | 'upsert' | 'update' | 'delete';
  private mutationPayload?: any;
  private onConflictColumn?: string;
  private returnSingle: boolean = false;
  private returnMaybeSingle: boolean = false;
  private rawOrFilters: string[] = [];

  constructor(table: string) {
    this.table = table;
  }

  not(column: string, op: string, value: any) {
    if (op === 'is' && value === null) {
      this.conditions.push({ column, op: 'IS NOT', value });
    } else if (op === 'in') {
      const match = typeof value === 'string' && value.startsWith('(') ? value.slice(1, -1).split(',').map(s => s.trim()) : value;
      this.conditions.push({ column, op: 'NOT IN', value: match });
    } else {
      this.conditions.push({ column, op: '!=', value });
    }
    return this;
  }

  select(columns: string = '*', _options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) {
    if (!this.mutationType) {
      this.selectColumns = columns || '*';
    }
    return this;
  }

  insert(values: any | any[]) {
    this.mutationType = 'insert';
    this.mutationPayload = values;
    return this;
  }

  upsert(values: any | any[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.mutationType = 'upsert';
    this.mutationPayload = values;
    this.onConflictColumn = options?.onConflict || 'id';
    return this;
  }

  update(values: any) {
    this.mutationType = 'update';
    this.mutationPayload = values;
    return this;
  }

  delete() {
    this.mutationType = 'delete';
    return this;
  }

  eq(column: string, value: any) {
    this.conditions.push({ column, op: '=', value });
    return this;
  }

  neq(column: string, value: any) {
    this.conditions.push({ column, op: '!=', value });
    return this;
  }

  gt(column: string, value: any) {
    this.conditions.push({ column, op: '>', value });
    return this;
  }

  gte(column: string, value: any) {
    this.conditions.push({ column, op: '>=', value });
    return this;
  }

  lt(column: string, value: any) {
    this.conditions.push({ column, op: '<', value });
    return this;
  }

  lte(column: string, value: any) {
    this.conditions.push({ column, op: '<=', value });
    return this;
  }

  like(column: string, pattern: string) {
    this.conditions.push({ column, op: 'LIKE', value: pattern });
    return this;
  }

  ilike(column: string, pattern: string) {
    this.conditions.push({ column, op: 'ILIKE', value: pattern });
    return this;
  }

  is(column: string, value: null | boolean) {
    this.conditions.push({ column, op: value === null ? 'IS' : '=', value });
    return this;
  }

  in(column: string, values: any[]) {
    this.conditions.push({ column, op: 'IN', value: values });
    return this;
  }

  or(filterString: string) {
    if (filterString && typeof filterString === 'string') {
      this.rawOrFilters.push(filterString.trim());
    }
    return this;
  }

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orderColumn = column;
    this.orderAscending = options?.ascending !== false;
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  range(from: number, to: number) {
    this.offsetCount = from;
    this.limitCount = to - from + 1;
    return this;
  }

  single() {
    this.returnSingle = true;
    return this.execute();
  }

  maybeSingle() {
    this.returnMaybeSingle = true;
    return this.execute();
  }

  then(onfulfilled?: (value: any) => any, onrejected?: (reason: any) => any) {
    return this.execute().then(onfulfilled, onrejected);
  }

  private parsePostgrestFilter(filterStr: string, paramIndex: { val: number }, values: any[]): string {
    const parts = filterStr.split(',').map((s) => s.trim()).filter(Boolean);
    const sqlParts: string[] = [];

    for (const part of parts) {
      if (part.startsWith('and(') && part.endsWith(')')) {
        const inner = part.slice(4, -1);
        const innerSql = this.parsePostgrestFilter(inner, paramIndex, values);
        if (innerSql) sqlParts.push(`(${innerSql})`);
        continue;
      }

      const match = part.match(/^([a-zA-Z0-9_.]+)\.([a-zA-Z0-9_]+)\.(.*)$/);
      if (!match) continue;

      const [, rawCol, op, rawVal] = match;
      const colName = rawCol.includes('.') ? rawCol.split('.').pop()! : rawCol;
      const colRef = `"${colName}"`;

      if (op === 'eq') {
        sqlParts.push(`${colRef} = $${paramIndex.val++}`);
        values.push(rawVal);
      } else if (op === 'neq') {
        sqlParts.push(`${colRef} != $${paramIndex.val++}`);
        values.push(rawVal);
      } else if (op === 'gte') {
        sqlParts.push(`${colRef} >= $${paramIndex.val++}`);
        values.push(rawVal);
      } else if (op === 'lte') {
        sqlParts.push(`${colRef} <= $${paramIndex.val++}`);
        values.push(rawVal);
      } else if (op === 'gt') {
        sqlParts.push(`${colRef} > $${paramIndex.val++}`);
        values.push(rawVal);
      } else if (op === 'lt') {
        sqlParts.push(`${colRef} < $${paramIndex.val++}`);
        values.push(rawVal);
      } else if (op === 'ilike') {
        sqlParts.push(`${colRef} ILIKE $${paramIndex.val++}`);
        values.push(rawVal.replace(/%/g, '%'));
      } else if (op === 'is') {
        if (rawVal === 'null') {
          sqlParts.push(`${colRef} IS NULL`);
        } else {
          sqlParts.push(`${colRef} = $${paramIndex.val++}`);
          values.push(rawVal === 'true');
        }
      } else if (op === 'in') {
        const cleaned = rawVal.replace(/^\(|\)$/g, '');
        const items = cleaned.split(',').map((s) => s.replace(/^["']|["']$/g, '').trim());
        if (items.length === 0) {
          sqlParts.push('1 = 0');
        } else {
          const ph = items.map(() => `$${paramIndex.val++}`).join(', ');
          sqlParts.push(`${colRef} IN (${ph})`);
          values.push(...items);
        }
      }
    }

    return sqlParts.join(' AND ');
  }

  private buildWhere(paramOffset: number = 1): { clause: string; values: any[] } {
    const clauses: string[] = [];
    const values: any[] = [];
    let idx = paramOffset;

    for (const cond of this.conditions) {
      if (cond.op === 'IS') {
        clauses.push(`"${cond.column}" IS NULL`);
      } else if (cond.op === 'IS NOT') {
        clauses.push(`"${cond.column}" IS NOT NULL`);
      } else if (cond.op === 'IN' || cond.op === 'NOT IN') {
        const arr = Array.isArray(cond.value) ? cond.value : [cond.value];
        if (arr.length === 0) {
          clauses.push(cond.op === 'IN' ? '1 = 0' : '1 = 1');
        } else {
          const placeholders = arr.map(() => `$${idx++}`).join(', ');
          clauses.push(`"${cond.column}" ${cond.op} (${placeholders})`);
          values.push(...arr);
        }
      } else {
        clauses.push(`"${cond.column}" ${cond.op} $${idx++}`);
        values.push(cond.value);
      }
    }

    for (const rawOr of this.rawOrFilters) {
      const paramIndex = { val: idx };
      const parsed = this.parsePostgrestFilter(rawOr, paramIndex, values);
      idx = paramIndex.val;
      if (parsed) {
        const orClauses = parsed.split(' AND ').map((c) => c.trim());
        clauses.push(`(${orClauses.join(' OR ')})`);
      }
    }

    if (clauses.length === 0) {
      return { clause: '', values: [] };
    }

    return { clause: ` WHERE ${clauses.join(' AND ')}`, values };
  }

  private async execute(): Promise<{ data: any; error: any; count?: number | null }> {
    const pool = getSandboxPool();

    try {
      if (this.mutationType === 'insert') {
        const rows = Array.isArray(this.mutationPayload)
          ? this.mutationPayload
          : [this.mutationPayload];
        if (rows.length === 0) return { data: [], error: null };

        const cols = Object.keys(rows[0]);
        const values: any[] = [];
        const rowPlaceholders: string[] = [];
        let pIdx = 1;

        for (const row of rows) {
          const rowVals: string[] = [];
          for (const c of cols) {
            let v = row[c];
            if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
              v = JSON.stringify(v);
            }
            values.push(v);
            rowVals.push(`$${pIdx++}`);
          }
          rowPlaceholders.push(`(${rowVals.join(', ')})`);
        }

        const sql = `INSERT INTO "${this.table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${rowPlaceholders.join(', ')} RETURNING *`;
        const res = await pool.query(sql, values);
        const data = Array.isArray(this.mutationPayload) ? res.rows : res.rows[0] ?? null;
        return { data, error: null };
      }

      if (this.mutationType === 'upsert') {
        const rows = Array.isArray(this.mutationPayload)
          ? this.mutationPayload
          : [this.mutationPayload];
        if (rows.length === 0) return { data: [], error: null };

        const cols = Object.keys(rows[0]);
        const conflictCol = this.onConflictColumn || 'id';
        const conflictColNames = conflictCol.split(',').map(c => c.trim());
        const updateCols = cols.filter((c) => !conflictColNames.includes(c));

        const values: any[] = [];
        const rowPlaceholders: string[] = [];
        let pIdx = 1;

        for (const row of rows) {
          const rowVals: string[] = [];
          for (const c of cols) {
            let v = row[c];
            if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
              v = JSON.stringify(v);
            }
            values.push(v);
            rowVals.push(`$${pIdx++}`);
          }
          rowPlaceholders.push(`(${rowVals.join(', ')})`);
        }

        const conflictColsFormatted = conflictCol.split(',').map(c => `"${c.trim()}"`).join(', ');

        let updateClause = 'DO NOTHING';
        if (updateCols.length > 0) {
          updateClause = `DO UPDATE SET ${updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')}`;
        }

        const sql = `INSERT INTO "${this.table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${rowPlaceholders.join(', ')} ON CONFLICT (${conflictColsFormatted}) ${updateClause} RETURNING *`;
        const res = await pool.query(sql, values);
        const data = Array.isArray(this.mutationPayload) ? res.rows : res.rows[0] ?? null;
        return { data, error: null };
      }

      if (this.mutationType === 'update') {
        const cols = Object.keys(this.mutationPayload);
        if (cols.length === 0) return { data: [], error: null };

        const values: any[] = [];
        const setClauses: string[] = [];
        let pIdx = 1;

        for (const c of cols) {
          let v = this.mutationPayload[c];
          if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
            v = JSON.stringify(v);
          }
          values.push(v);
          setClauses.push(`"${c}" = $${pIdx++}`);
        }

        const where = this.buildWhere(pIdx);
        values.push(...where.values);

        const sql = `UPDATE "${this.table}" SET ${setClauses.join(', ')}${where.clause} RETURNING *`;
        const res = await pool.query(sql, values);
        return { data: res.rows, error: null, count: res.rowCount };
      }

      if (this.mutationType === 'delete') {
        const where = this.buildWhere(1);
        const sql = `DELETE FROM "${this.table}"${where.clause} RETURNING *`;
        const res = await pool.query(sql, where.values);
        return { data: res.rows, error: null, count: res.rowCount };
      }

      // Default: SELECT
      const hasProfilesEmbed = this.table === 'gh_candidate_applications' && this.selectColumns.includes('profiles');
      const isInnerJoin = hasProfilesEmbed && this.selectColumns.includes('!inner');

      let sql = '';
      if (hasProfilesEmbed) {
        const cleanedCols = this.selectColumns
          .replace(/profiles(!inner)?\([^)]*\)/g, '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);

        const mainSelect = cleanedCols.length === 0 || cleanedCols.includes('*')
          ? 'a.*'
          : cleanedCols.map((c) => `a."${c}"`).join(', ');

        const joinType = isInnerJoin ? 'INNER JOIN' : 'LEFT JOIN';
        sql = `SELECT ${mainSelect}, json_build_object('client_name', p.client_name, 'ca_email', p.ca_email, 'applywizz_id', p.applywizz_id) AS profiles FROM "${this.table}" a ${joinType} profiles p ON a.applywizz_id = p.applywizz_id`;
      } else {
        sql = `SELECT ${this.selectColumns === '*' ? '*' : this.selectColumns} FROM "${this.table}"`;
      }

      const where = this.buildWhere(1);
      sql += where.clause;

      if (this.orderColumn) {
        const orderColRef = hasProfilesEmbed ? `a."${this.orderColumn}"` : `"${this.orderColumn}"`;
        sql += ` ORDER BY ${orderColRef} ${this.orderAscending ? 'ASC' : 'DESC'}`;
      }

      const values = [...where.values];
      let pIdx = values.length + 1;

      if (this.limitCount !== undefined) {
        sql += ` LIMIT $${pIdx++}`;
        values.push(this.limitCount);
      }
      if (this.offsetCount !== undefined) {
        sql += ` OFFSET $${pIdx++}`;
        values.push(this.offsetCount);
      }

      const res = await pool.query(sql, values);
      let data: any = res.rows;

      if (this.returnSingle) {
        if (res.rows.length === 0) {
          return { data: null, error: new Error('JSON object requested, multiple (or no) rows returned') };
        }
        data = res.rows[0];
      } else if (this.returnMaybeSingle) {
        data = res.rows[0] ?? null;
      }

      return { data, error: null, count: res.rowCount };
    } catch (err: any) {
      log.error(`Sandbox query error on "${this.table}":`, err.message || err);
      return { data: null, error: err };
    }
  }
}

// -----------------------------------------------------------------------------
// Sandbox Client (Supabase Facade)
// -----------------------------------------------------------------------------

export class SandboxClient {
  public storage = new SandboxStorageClient();

  public auth = {
    getUser: async (_token?: string) => ({
      data: {
        user: {
          id: 'sandbox-dev-user-uuid',
          email: 'yaswanthnaiduyalla@applywizz.ai',
          app_metadata: { role: 'dev' },
          user_metadata: { role: 'dev' },
        },
      },
      error: null,
    }),
    admin: {
      listUsers: async () => ({
        data: {
          users: [
            {
              id: 'sandbox-dev-user-uuid',
              email: 'yaswanthnaiduyalla@applywizz.ai',
              app_metadata: { role: 'dev' },
            },
          ],
        },
        error: null,
      }),
    },
  };

  from(table: string): SandboxQueryBuilder {
    return new SandboxQueryBuilder(table);
  }

  async rpc(funcName: string, params: Record<string, any> = {}) {
    const pool = getSandboxPool();
    try {
      const keys = Object.keys(params);
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const values = keys.map((k) => {
        const val = params[k];
        // Format number arrays for pgvector parameters (e.g. query_vector in match_candidate_qa)
        if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'number') {
          return `[${val.join(',')}]`;
        }
        return val;
      });
      const sql = `SELECT * FROM ${funcName}(${placeholders})`;
      const res = await pool.query(sql, values);
      return { data: res.rows, error: null };
    } catch (err: any) {
      // In sandbox, if an RPC like match_candidate_qa is called but vector search is inactive, fail safely
      const rawMsg = err.message || String(err);
      // Sanitize vector / embedding arrays from error logs so huge float vectors are never printed
      const sanitizedMsg = rawMsg
        .replace(/(\[|\{)"?-?\d+\.\d+"?(?:,"?-?\d+\.\d+"?){3,}(\]|\})/g, '[...vector...]')
        .replace(/"?(\[-?\d+\.\d+.*\]|\{-?\d+\.\d+.*\})"?,?/g, '[...vector...]');
      log.warn(`Sandbox RPC "${funcName}" execution note:`, sanitizedMsg);
      return { data: [], error: null };
    }
  }
}

let sandboxClientInstance: SandboxClient | null = null;

export function getSandboxClient(): SandboxClient {
  if (!sandboxClientInstance) {
    sandboxClientInstance = new SandboxClient();
  }
  return sandboxClientInstance;
}

// -----------------------------------------------------------------------------
// Database Migration & Seeding Runners
// -----------------------------------------------------------------------------

export async function ensureSandboxDatabaseExists(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/applywizz_sandbox';

  const match = connectionString.match(/\/([^/?]+)(\?.*)?$/);
  const targetDb = match ? match[1] : 'applywizz_sandbox';
  const adminUrl = connectionString.replace(/\/([^/?]+)(\?.*)?$/, '/postgres$2');

  const { Client } = pg;
  const adminClient = new Client({ connectionString: adminUrl });

  try {
    await adminClient.connect();
    const res = await adminClient.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [targetDb]
    );
    if (res.rowCount === 0) {
      log.info(`Creating database "${targetDb}"...`);
      await adminClient.query(`CREATE DATABASE "${targetDb}"`);
      log.info(`✅ Database "${targetDb}" created.`);
    }
  } catch (err: any) {
    log.warn(`Notice while verifying database "${targetDb}": ${err.message || err}`);
  } finally {
    try {
      await adminClient.end();
    } catch {}
  }
}

export async function runSandboxMigrations(): Promise<void> {
  await ensureSandboxDatabaseExists();
  const pool = getSandboxPool();
  log.info('🛠️ Initializing local Sandbox PostgreSQL database & running migrations...');

  // 1. Run base schema
  const schemaPath = path.resolve(process.cwd(), 'src/db/schema.sql');
  if (fs.existsSync(schemaPath)) {
    log.info('Running base schema src/db/schema.sql...');
    // Ensure mock schema & storage.objects table exists so Supabase storage policies don't fail
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE TABLE IF NOT EXISTS storage.objects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_id TEXT,
        name TEXT,
        owner UUID,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        last_accessed_at TIMESTAMPTZ DEFAULT now(),
        metadata JSONB DEFAULT '{}'::jsonb,
        path_tokens TEXT[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED
      );
    `);
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schemaSql);
  }

  // Ensure service_role and authenticated roles exist in sandbox postgres so migrations don't fail
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon;
      END IF;
    END $$;
  `);

  // Ensure profiles.ca_email and resume_storage_path exist before migrations/code try to use them
  await pool.query(`
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ca_email TEXT;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS resume_storage_path TEXT;
  `);

  // 2. Run all migration files in order
  const migrationsDir = path.resolve(process.cwd(), 'src/db/migrations');
  if (fs.existsSync(migrationsDir)) {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      let sql = fs.readFileSync(filePath, 'utf8');
      // Strip UTF-8 byte order mark (BOM) if present
      if (sql.charCodeAt(0) === 0xfeff) {
        sql = sql.slice(1);
      }
      try {
        await pool.query(sql);
        log.info(`✅ Migration applied: ${file}`);
      } catch (err: any) {
        log.warn(`⚠️ Migration notice in ${file}: ${err.message || err}`);
      }
    }
  }

  // Ensure legacy/transitional columns on profiles exist in sandbox so profile caching and upserts succeed cleanly
  await pool.query(`
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS resume_storage_path TEXT;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_api_fetch_at TIMESTAMPTZ;
  `);

  // 3. Copy profiles from remote DB2 directly into local sandbox DB
  await copyProfilesFromDb2(pool);

  // 3b. Backfill profiles.zoho_connected from Zoho Mail Connector API
  await backfillZohoConnectedProfiles(pool);

  // Sandbox dashboards assign every candidate and application to the dev operator.
  await pool.query(
    `UPDATE profiles SET ca_email = $1 WHERE ca_email IS DISTINCT FROM $1`,
    [SANDBOX_CA_EMAIL]
  );
  await pool.query(
    `UPDATE gh_candidate_applications SET assigned_ca_email = $1 WHERE assigned_ca_email IS DISTINCT FROM $1`,
    [SANDBOX_CA_EMAIL]
  );

  // 4. Seed demo job templates, applications, and auth user
  await seedSandboxDemoData();
}

/**
 * Copies the complete profiles table from remote DB2 into the local sandbox database.
 */
export async function copyProfilesFromDb2(localPool: pg.Pool): Promise<void> {
  const db2Url = process.env.DB2_DATABASE_URL;
  if (!db2Url) {
    throw new Error('DB2_DATABASE_URL is not set in .env.sandbox. Cannot copy profiles from DB2.');
  }

  log.info('📦 Connecting to DB2 to copy profiles table into sandbox...');
  const remoteClient = new pg.Client({
    connectionString: db2Url,
    ssl: { rejectUnauthorized: false },
  });

  await remoteClient.connect();
  try {
    const res = await remoteClient.query('SELECT * FROM profiles ORDER BY created_at ASC;');
    log.info(`Fetched ${res.rows.length} profiles from DB2. Copying into sandbox DB...`);

    if (res.rows.length === 0) return;

    const client = await localPool.connect();
    try {
      await client.query('BEGIN');
      const cols = Object.keys(res.rows[0]);
      const colNames = cols.map((c) => `"${c}"`).join(', ');

      for (const row of res.rows) {
        row.ca_email = SANDBOX_CA_EMAIL;
        const values = cols.map((c) => {
          const val = row[c];
          if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
            return JSON.stringify(val);
          }
          return val;
        });
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        const updateSet = cols
          .filter((c) => c !== 'id' && c !== 'applywizz_id')
          .map((c) => `"${c}" = EXCLUDED."${c}"`)
          .join(', ');

        await client.query(
          `INSERT INTO profiles (${colNames}) VALUES (${placeholders})
           ON CONFLICT (applywizz_id) DO UPDATE SET ${updateSet};`,
          values
        );
      }
      await client.query('COMMIT');
      log.info(`✅ Successfully copied ${res.rows.length} profiles from DB2 into sandbox database.`);
    } catch (insertErr) {
      await client.query('ROLLBACK');
      throw insertErr;
    } finally {
      client.release();
    }
  } finally {
    await remoteClient.end();
  }
}

/**
 * Backfills profiles.zoho_connected from the Zoho Mail Reader REST API.
 */
export async function backfillZohoConnectedProfiles(pool: pg.Pool): Promise<number> {
  const connectorUrl = process.env.ZOHO_CONNECTOR_URL || 'https://zoho-mail-reader.onrender.com/';
  const url = `${connectorUrl.replace(/\/+$/, '')}/api/zoho/ui/users`;
  log.info(`[Sandbox] 🌐 Fetching connected Zoho mailboxes from ${url}...`);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      log.warn(`[Sandbox] ⚠️ Zoho connector returned HTTP ${res.status}: ${res.statusText}. Preserving copied DB2 flags.`);
      return 0;
    }

    const data = (await res.json()) as { users?: Array<{ email: string; connected: boolean }> };
    const connectedEmails = (data.users || [])
      .filter((u) => u.connected && u.email)
      .map((u) => u.email.toLowerCase().trim());

    log.info(`[Sandbox] 📊 Found ${connectedEmails.length} connected mailboxes in Zoho connector.`);

    // Reset zoho_connected to false first
    await pool.query('UPDATE profiles SET zoho_connected = false');

    const demoIds = ['AWL-YASWANTH', 'AWL-31428', 'AWL-YASHANTH'];
    let count = 0;
    if (connectedEmails.length > 0) {
      const updateRes = await pool.query(
        `UPDATE profiles 
         SET zoho_connected = true 
         WHERE LOWER(company_email) = ANY($1) 
            OR LOWER(email) = ANY($1) 
            OR applywizz_id = ANY($2)`,
        [connectedEmails, demoIds]
      );
      count = updateRes.rowCount || 0;
    } else {
      const updateRes = await pool.query(
        `UPDATE profiles SET zoho_connected = true WHERE applywizz_id = ANY($1)`,
        [demoIds]
      );
      count = updateRes.rowCount || 0;
    }

    log.info(`[Sandbox] ✅ Zoho connected backfill complete: marked ${count} profiles Zoho-connected.`);
    return count;
  } catch (err: any) {
    log.warn(`[Sandbox] ⚠️ Zoho connected backfill warning: ${err.message}. Preserving copied DB2 flags.`);
    return 0;
  }
}

export async function seedSandboxDemoData(): Promise<void> {
  const client = getSandboxClient();
  log.info('🌱 Seeding demo fixtures (templates, applications, dev user) into Sandbox DB...');

  try {
    // 4. Seed demo user for authDirectory
    await client.from('gh_users').upsert(
      {
        email: 'yaswanthnaiduyalla@applywizz.ai',
        name: 'Yaswanth Naidu Yalla',
        role: 'dev',
      },
      { onConflict: 'email' }
    );

    // 5. Ensure resume file mock exists in sandbox storage
    const storage = client.storage.from('resumes');
    const dummyPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Title (Akshitha Resume) >>\nendobj\ntrailer\n<< >>\n%%EOF');
    await storage.upload('AWL-31428_resume.pdf', dummyPdf, { upsert: true });

    log.info('✅ AWL-31428 fixtures successfully seeded in local sandbox database.');
  } catch (err: any) {
    log.error('Failed to seed sandbox fixtures:', err.message || err);
  }
}
