import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { decodeSnapshotEmbedding, importSnapshotRows, importSnapshotTransaction } from '../scripts/importBatchSnapshotToSandbox.js';

const { prepareValue } = createRequire(import.meta.url)('pg/lib/utils') as { prepareValue: (value: unknown) => unknown };

test('snapshot pgvector binary decodes to the local pgvector text input', () => {
  const bytes = Buffer.alloc(6148);
  bytes.writeInt16BE(1536, 0);
  bytes.writeInt16BE(0, 2);
  bytes.writeFloatBE(1, 4);
  bytes.writeFloatBE(-0.25, 8);

  const vector = decodeSnapshotEmbedding(bytes.toString('base64'))!;
  assert.match(vector, /^\[1,-0\.25,0,0,/);
  assert.equal(vector.slice(-1), ']');
  assert.equal(decodeSnapshotEmbedding(null), null);
});

test('snapshot pgvector binary rejects the wrong dimensions and invalid floats', () => {
  const wrongDimensions = Buffer.alloc(6148);
  wrongDimensions.writeInt16BE(1535, 0);
  assert.throws(() => decodeSnapshotEmbedding(wrongDimensions.toString('base64')), /invalid pgvector binary shape/);

  const invalidValue = Buffer.alloc(6148);
  invalidValue.writeInt16BE(1536, 0);
  invalidValue.writeFloatBE(Number.NaN, 4);
  assert.throws(() => decodeSnapshotEmbedding(invalidValue.toString('base64')), /non-finite/);
});

test('snapshot conflict comparison matches pgvector values at float32 precision', async () => {
  const bytes = Buffer.alloc(6148);
  bytes.writeInt16BE(1536, 0);
  bytes.writeFloatBE(0.1, 4);
  bytes.writeFloatBE(-0, 8);
  const incomingVector = decodeSnapshotEmbedding(bytes.toString('base64'))!;
  const localVector = `[0.10000000149011612,0,${Array(1534).fill(0).join(',')}]`;
  const qa = Object.assign(Array(10).fill(null), { 0: 'vector-candidate', 1: 'fingerprint', 9: incomingVector });
  const client = { async query(sql: string) {
    if (sql.includes('FROM public."profiles"')) return { rows: [] };
    if (sql.includes('FROM public."gh_candidate_qa_bank"')) {
      const columns = sql.slice(7, sql.indexOf(' FROM')).split(', ').map((column) => column.slice(1, -1));
      return { rows: [Object.fromEntries(columns.map((column) => [column,
        column === 'applywizz_id' ? 'vector-candidate'
          : column === 'question_fingerprint' ? 'fingerprint'
            : column === 'embedding' ? localVector : null]))] };
    }
    if (sql.startsWith('INSERT')) return { rowCount: 0 };
    assert.fail(`unexpected query for identical vector conflict: ${sql}`);
  } };

  const result = await importSnapshotRows(client, [], [qa]);
  assert.equal(result.qaEntriesSkipped, 1);
  assert.equal(result.qaEntriesApplied, 0);
});

test('snapshot conflict comparison rejects malformed or different pgvector shapes and values', async () => {
  const qa = (vector: unknown) => Object.assign(Array(10).fill(null), {
    0: 'vector-candidate', 1: 'fingerprint', 9: vector,
  });
  const check = async (localVector: unknown, incomingVector: unknown) => {
    const client = { async query(sql: string) {
      if (sql.includes('FROM public."profiles"')) return { rows: [] };
      if (sql.includes('FROM public."gh_candidate_qa_bank"')) {
        const columns = sql.slice(7, sql.indexOf(' FROM')).split(', ').map((column) => column.slice(1, -1));
        return { rows: [Object.fromEntries(columns.map((column) => [column,
          column === 'applywizz_id' ? 'vector-candidate'
            : column === 'question_fingerprint' ? 'fingerprint'
              : column === 'embedding' ? localVector : null]))] };
      }
      if (sql.startsWith('INSERT')) return { rowCount: 0 };
      assert.fail(`unexpected query for different vector conflict: ${sql}`);
    } };
    await assert.rejects(importSnapshotRows(client, [], [qa(incomingVector)]), /conflicts differ|malformed/);
  };

  await check('[0.1,0]', '[0.1]');
  await check('[0.1]', '[0.2]');
  await check('[0.1]', '[NaN]');
  await check(null, '[0.1]');
});

test('snapshot imports overwrite scoped conflicts and remain idempotent', async () => {
  const profile = (id: string, name: string) => Object.assign(Array(26).fill(null), { 0: id, 1: name });
  const qa = (id: string, fingerprint: string, value: string) =>
    Object.assign(Array(10).fill(null), { 0: id, 1: fingerprint, 4: value });
  const existing = new Map<string, Map<string, unknown[]>>([
    ['profiles', new Map([['profile-existing', profile('profile-existing', 'local name')], ['unrelated', profile('unrelated', 'keep me')]])],
    ['gh_candidate_qa_bank', new Map([['qa-existing|fingerprint-existing', qa('qa-existing', 'fingerprint-existing', 'local answer')], ['unrelated|other', qa('unrelated', 'other', 'keep me')]])],
  ]);
  let writes = 0;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const select = /^SELECT (.+) FROM public\."(profiles|gh_candidate_qa_bank)" WHERE "applywizz_id" = ANY/.exec(sql);
      if (select) {
        const [, rawColumns, table] = select;
        const columns = rawColumns.split(', ').map((column) => column.slice(1, -1));
        return { rows: [...(existing.get(table)?.values() ?? [])].map((row) =>
          Object.fromEntries(columns.map((column) => [column, row[table === 'profiles'
            ? ['applywizz_id', 'client_name', 'first_name', 'last_name', 'email', 'company_email', 'phone', 'country', 'country_code', 'location', 'linkedin_url', 'website_url', 'github_url', 'work_authorization', 'requires_sponsorship', 'education', 'work_experience', 'resume_url', 'resume_text', 'resume_facts', 'raw_api_payload', 'zoho_connected', 'created_at', 'updated_at', 'ca_email', 'resume_storage_path'].indexOf(column)
            : ['applywizz_id', 'question_fingerprint', 'question_label', 'field_type', 'value', 'source', 'confidence', 'created_at', 'updated_at', 'embedding'].indexOf(column)]]))
        ) };
      }
      const statement = /^INSERT INTO public\."([^"]+)" AS target \(([^)]+)\) VALUES .* ON CONFLICT \(([^)]+)\) DO UPDATE SET /.exec(sql);
      assert.ok(statement, `expected generated snapshot-overwriting INSERT, got ${sql}`);
      const [, table, rawColumns, rawConflictColumns] = statement;
      writes += 1;
      const columns = rawColumns.split(', ').map((column) => column.slice(1, -1));
      const conflictColumns = rawConflictColumns.split(', ').map((column) => column.slice(1, -1));
      const conflictIndexes = conflictColumns.map((column) => columns.indexOf(column));
      const tableRows = existing.get(table) ?? new Map<string, unknown[]>();
      existing.set(table, tableRows);
      let rowCount = 0;
      for (let offset = 0; offset < values.length; offset += columns.length) {
        const row = values.slice(offset, offset + columns.length);
        const key = conflictIndexes.map((index) => String(row[index])).join('|');
        const previous = tableRows.get(key);
        if (previous && JSON.stringify(previous) === JSON.stringify(row)) continue;
        tableRows.set(key, row);
        rowCount += 1;
      }
      return { rowCount };
    },
  };

  const profileRows = [profile('profile-existing', 'snapshot name'), profile('profile-new', 'snapshot name')];
  const qaRows = [qa('qa-existing', 'fingerprint-existing', 'snapshot answer'), qa('qa-new', 'fingerprint-new', 'snapshot answer')];
  const result = await importSnapshotRows(
    client,
    profileRows,
    qaRows
  );

  assert.deepEqual(result, {
    profilesApplied: 2,
    profilesSkipped: 0,
    qaEntriesApplied: 2,
    qaEntriesSkipped: 0,
  });
  assert.equal(existing.get('profiles')!.get('profile-existing')![1], 'snapshot name');
  assert.equal(existing.get('profiles')!.get('unrelated')![1], 'keep me');
  assert.equal(existing.get('profiles')!.get('profile-new')![1], 'snapshot name');
  assert.equal(existing.get('gh_candidate_qa_bank')!.get('qa-existing|fingerprint-existing')![4], 'snapshot answer');
  assert.equal(existing.get('gh_candidate_qa_bank')!.get('unrelated|other')![4], 'keep me');
  assert.equal(existing.get('gh_candidate_qa_bank')!.get('qa-new|fingerprint-new')![4], 'snapshot answer');
  const initialWrites = writes;
  assert.deepEqual(await importSnapshotRows(client, profileRows, qaRows), {
    profilesApplied: 0, profilesSkipped: 2, qaEntriesApplied: 0, qaEntriesSkipped: 2,
  });
  assert.equal(writes, initialWrites + 2, 'idempotent INSERT statements still run and PostgreSQL skips identical conflicts');
});

test('snapshot conflict mismatches are overwritten and verified', async () => {
  const profile = (id: string, resumeText: string) => Object.assign(Array(26).fill(null), { 0: id, 18: resumeText });
  const qa = (id: string, fingerprint: string, value: string) => Object.assign(Array(10).fill(null), { 0: id, 1: fingerprint, 4: value });
  let currentProfileName = 'local name';
  let currentResume = 'locally edited resume';
  let currentQaValue = 'Yes';
  let writes = 0;
  const client = {
    async query(sql: string) {
      if (sql.includes('FROM public."profiles"')) {
        const columns = ['applywizz_id', 'client_name', 'first_name', 'last_name', 'email', 'company_email', 'phone', 'country', 'country_code', 'location', 'linkedin_url', 'website_url', 'github_url', 'work_authorization', 'requires_sponsorship', 'education', 'work_experience', 'resume_url', 'resume_text', 'resume_facts', 'raw_api_payload', 'zoho_connected', 'ca_email', 'resume_storage_path'];
        return { rows: [Object.fromEntries(columns.map((column) => [column, column === 'applywizz_id' ? 'candidate-42' : column === 'resume_text' ? currentResume : column === 'client_name' ? currentProfileName : null]))] };
      }
      if (sql.includes('FROM public."gh_candidate_qa_bank"')) {
        const columns = ['applywizz_id', 'question_fingerprint', 'question_label', 'field_type', 'value', 'source', 'confidence', 'embedding'];
        return { rows: [Object.fromEntries(columns.map((column) => [column, column === 'applywizz_id' ? 'candidate-42' : column === 'question_fingerprint' ? 'work-auth' : column === 'value' ? currentQaValue : null]))] };
      }
      if (sql.startsWith('INSERT')) {
        writes += 1;
        const table = /INSERT INTO public\."([^"]+)"/.exec(sql)![1];
        if (table === 'profiles') { currentProfileName = 'snapshot name'; currentResume = 'snapshot resume'; }
        else currentQaValue = 'No';
        return { rowCount: 1 };
      }
      assert.fail(`unexpected query: ${sql}`);
    },
  };
  await importSnapshotRows(client, [Object.assign(profile('candidate-42', 'snapshot resume'), { 1: 'snapshot name' })], [qa('candidate-42', 'work-auth', 'No')]);
  assert.equal(writes, 2);
  assert.equal(currentProfileName, 'snapshot name');
  assert.equal(currentResume, 'snapshot resume');
  assert.equal(currentQaValue, 'No');
});

test('snapshot rejects contradictory duplicate profile and QA keys before writes', async () => {
  let writes = 0;
  const client = { async query(sql: string) { if (sql.startsWith('INSERT')) writes++; return { rows: [] }; } };
  const profile = (id: string, name: string) => Object.assign(Array(26).fill(null), { 0: id, 1: name });
  const qa = (id: string, fingerprint: string, value: string) => Object.assign(Array(10).fill(null), { 0: id, 1: fingerprint, 4: value });
  await assert.rejects(importSnapshotRows(client, [profile('p1', 'A'), profile('p1', 'B')], []), /contradictory duplicate profile/);
  await assert.rejects(importSnapshotRows(client, [], [qa('p1', 'q1', 'A'), qa('p1', 'q1', 'B')]), /contradictory duplicate QA/);
  assert.equal(writes, 0);
});

test('snapshot canonical comparison handles nested JSON key ordering', async () => {
  const profile = Object.assign(Array(26).fill(null), { 0: 'nested', 19: { outer: { alpha: 1, beta: [{ x: 2, y: 3 }] } } });
  let selectCount = 0;
  const client = { async query(sql: string) {
    if (sql.startsWith('SELECT')) {
      selectCount++;
      const cols = sql.slice(7, sql.indexOf(' FROM')).split(', ').map((c) => c.slice(1, -1));
      const values: Record<string, unknown> = { applywizz_id: 'nested', resume_facts: { outer: { beta: [{ y: 3, x: 2 }], alpha: 1 } } };
      return { rows: [Object.fromEntries(cols.map((c) => [c, values[c] ?? null]))] };
    }
    return { rowCount: 0 };
  } };
  const result = await importSnapshotRows(client, [profile], []);
  assert.equal(result.profilesSkipped, 1);
  assert.equal(selectCount, 2, 'post-write verification checks both tables');
});

test('profile JSONB values use pg JSON serialization while SQL null and vector values stay intact', async () => {
  const education = [{ school: 'A', details: { degrees: ['BSc', 'MSc'] } }];
  const workExperience = [{ company: 'B', roles: [{ title: 'Engineer', tags: ['API', 'DB'] }] }];
  const resumeFacts = { contact: { emails: ['a@example.test'] }, skills: [{ name: 'TypeScript' }] };
  const rawPayload = { profile: { history: [{ year: 2020, metadata: { verified: true } }] } };
  const profile = Object.assign(Array(26).fill(null), {
    0: 'jsonb-candidate', 15: education, 16: workExperience, 19: resumeFacts, 20: rawPayload,
  });
  const inserted: Array<{ table: string; columns: string[]; values: unknown[] }> = [];
  let profileReads = 0;
  const client = { async query(sql: string, values: unknown[] = []) {
    if (sql.startsWith('SELECT')) {
      if (!sql.includes('FROM public."profiles"')) return { rows: [] };
      profileReads++;
      const imported = inserted.find((insert) => insert.table === 'profiles');
      if (!imported) return { rows: [] };
      const importedRow = Object.fromEntries(imported.columns.map((column, index) => {
        const value = imported.values[index];
        return [column, ['education', 'work_experience', 'resume_facts', 'raw_api_payload'].includes(column) && typeof value === 'string' ? JSON.parse(value) : value];
      }));
      const columns = sql.slice(7, sql.indexOf(' FROM')).split(', ').map((column) => column.slice(1, -1));
      return { rows: [Object.fromEntries(columns.map((column) => [column, importedRow[column]]))] };
    }
    const table = /INSERT INTO public\."([^"]+)"/.exec(sql)?.[1];
    const rawColumns = /\(([^)]+)\) VALUES/.exec(sql)?.[1];
    assert.ok(table && rawColumns);
    inserted.push({ table, columns: rawColumns.split(', ').map((column) => column.slice(1, -1)), values });
    return { rowCount: values.length ? values.length / rawColumns.split(', ').length : 0 };
  } };

  await importSnapshotRows(client, [profile], []);
  const profileInsert = inserted.find((insert) => insert.table === 'profiles')!;
  for (const [column, expected] of Object.entries({ education, work_experience: workExperience, resume_facts: resumeFacts, raw_api_payload: rawPayload })) {
    const value = profileInsert.values[profileInsert.columns.indexOf(column)];
    const pgValue = prepareValue(value);
    assert.equal(typeof pgValue, 'string', `${column} must be sent as JSON text, not a PostgreSQL array`);
    assert.deepEqual(JSON.parse(pgValue as string), expected);
  }
  assert.equal(prepareValue(profileInsert.values[profileInsert.columns.indexOf('zoho_connected')]), null, 'SQL NULL remains SQL NULL');

  const vector = '[1,-0.25,0]';
  assert.equal(prepareValue(vector), vector, 'pgvector text input remains unchanged');
});

test('transaction rolls back when post-import validation sees drift', async () => {
  const profile = Object.assign(Array(26).fill(null), { 0: 'drift', 1: 'snapshot name' });
  const states: string[] = [];
  let inserted = false;
  const client = { async query(sql: string) {
    states.push(sql);
    if (sql.startsWith('SELECT')) {
      const cols = sql.slice(7, sql.indexOf(' FROM')).split(', ').map((c) => c.slice(1, -1));
      const name = inserted ? 'concurrent edit' : 'snapshot name';
      return { rows: [Object.fromEntries(cols.map((c) => [c, c === 'applywizz_id' ? 'drift' : c === 'client_name' ? name : null]))] };
    }
    if (sql.startsWith('INSERT')) { inserted = true; return { rowCount: 1 }; }
    return {};
  } };
  await assert.rejects(importSnapshotTransaction(client, [profile], [], true), /profiles=1; qa=0/);
  assert.equal(states[0], 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.equal(states.at(-1), 'ROLLBACK');
  assert.ok(states.some((sql) => sql.endsWith('FOR UPDATE')));
});

test('serialization failures roll back and fail closed', async () => {
  const failure = Object.assign(new Error('serialization'), { code: '40001' });
  const states: string[] = [];
  const client = { async query(sql: string) { states.push(sql); if (sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE') return {}; throw failure; } };
  await assert.rejects(importSnapshotTransaction(client, [], [], true), /serialization conflict; transaction rolled back/);
  assert.equal(states.at(-1), 'ROLLBACK');
});

test('unverified database guard fails before opening a transaction or setting the override', async () => {
  const states: string[] = [];
  const client = { async query(sql: string) { states.push(sql); return {}; } };
  await assert.rejects(importSnapshotTransaction(client, [], [], false), /verified local sandbox database/);
  assert.deepEqual(states, []);
});

test('transaction replaces exact QA keys for snapshot profiles, including zero-QA candidates, and preserves unrelated rows', async () => {
  const profile = (id: string) => Object.assign(Array(26).fill(null), { 0: id });
  const qa = (id: string, fingerprint: string, value: string) => Object.assign(Array(10).fill(null), { 0: id, 1: fingerprint, 4: value });
  const profiles = new Map([['zero-qa', profile('zero-qa')], ['has-qa', profile('has-qa')]]);
  const qaRows = new Map([
    ['zero-qa|stale', qa('zero-qa', 'stale', 'remove me')],
    ['has-qa|keep', qa('has-qa', 'keep', 'old value')],
    ['has-qa|stale', qa('has-qa', 'stale', 'remove me')],
    ['outside|keep', qa('outside', 'keep', 'unrelated')],
  ]);
  const states: string[] = [];
  const client = { async query(sql: string, values: unknown[] = []) {
    states.push(sql);
    if (sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE' || sql === "SET LOCAL app.profile_authoritative_override = 'on'" || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (sql.startsWith('INSERT')) {
      const table = /INSERT INTO public\."([^"]+)"/.exec(sql)![1];
      const cols = /\(([^)]+)\) VALUES/.exec(sql)![1].split(', ').map((c) => c.slice(1, -1));
      const rows = values.reduce<unknown[][]>((all, v, i) => { const idx = Math.floor(i / cols.length); (all[idx] ??= []).push(v); return all; }, []);
      let rowCount = 0;
      if (table === 'profiles') for (const row of rows) {
        const previous = profiles.get(String(row[0]));
        if (JSON.stringify(previous) !== JSON.stringify(row)) rowCount++;
        profiles.set(String(row[0]), row as never);
      } else for (const row of rows) {
        const key = `${row[0]}|${row[1]}`;
        const previous = qaRows.get(key);
        if (JSON.stringify(previous) !== JSON.stringify(row)) rowCount++;
        qaRows.set(key, row as never);
      }
      return { rowCount };
    }
    if (sql.startsWith('DELETE FROM public."gh_candidate_qa_bank"')) {
      const ids = new Set(values[0] as string[]);
      const keys = new Set((values[1] as string[]).map((id, index) => `${id}|${(values[2] as string[])[index]}`));
      for (const key of qaRows.keys()) if (ids.has(key.split('|')[0]) && !keys.has(key)) qaRows.delete(key);
      return {};
    }
    if (sql.includes('FROM public."profiles"')) {
      const columns = sql.slice(7, sql.indexOf(' FROM')).split(', ').map((column) => column.slice(1, -1));
      const profileColumns = ['applywizz_id', 'client_name', 'first_name', 'last_name', 'email', 'company_email', 'phone', 'country', 'country_code', 'location', 'linkedin_url', 'website_url', 'github_url', 'work_authorization', 'requires_sponsorship', 'education', 'work_experience', 'resume_url', 'resume_text', 'resume_facts', 'raw_api_payload', 'zoho_connected', 'created_at', 'updated_at', 'ca_email', 'resume_storage_path'];
      return { rows: (values[0] as string[]).map((id) => Object.fromEntries(columns.map((column) => [column, profiles.get(id)?.[profileColumns.indexOf(column)] ?? null]))) };
    }
    if (sql.includes('FROM public."gh_candidate_qa_bank"')) {
      return { rows: [...qaRows.entries()].filter(([key]) => (values[0] as string[]).includes(key.split('|')[0])).map(([, row]) => {
        const columns = ['applywizz_id', 'question_fingerprint', 'question_label', 'field_type', 'value', 'source', 'confidence', 'embedding'];
        return Object.fromEntries(columns.map((column, index) => [column, (row as unknown[])[[0, 1, 2, 3, 4, 5, 6, 9][index]]]));
      }) };
    }
    assert.fail(`unexpected query: ${sql}`);
  } };
  const snapshotProfiles = [...profiles.values()];
  const snapshotQa = [qa('has-qa', 'keep', 'new value')];
  const result = await importSnapshotTransaction(client, snapshotProfiles, snapshotQa, true);
  assert.equal(result.qaEntriesApplied, 1);
  assert.deepEqual([...qaRows.keys()].sort(), ['has-qa|keep', 'outside|keep']);
  assert.equal((qaRows.get('has-qa|keep') as unknown[])[4], 'new value');
  assert.equal(states[0], 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.equal(states.at(-1), 'COMMIT');
  assert.equal(states[1], "SET LOCAL app.profile_authoritative_override = 'on'");
  assert.ok(states.indexOf("SET LOCAL app.profile_authoritative_override = 'on'") < states.findIndex((sql) => sql.startsWith('INSERT')));
  assert.equal(states.filter((sql) => sql.startsWith('SET LOCAL app.profile_authoritative_override')).length, 1);
  const repeated = await importSnapshotTransaction(client, snapshotProfiles, snapshotQa, true);
  assert.equal(repeated.profilesApplied, 0);
  assert.equal(repeated.qaEntriesApplied, 0);
  assert.equal(repeated.qaEntriesSkipped, 1);
  assert.deepEqual([...qaRows.keys()].sort(), ['has-qa|keep', 'outside|keep']);
});

test('exact scoped QA postcheck failure rolls back the replacement transaction', async () => {
  const profile = Object.assign(Array(26).fill(null), { 0: 'scoped' });
  const qa = Object.assign(Array(10).fill(null), { 0: 'scoped', 1: 'expected', 4: 'answer' });
  const states: string[] = [];
  let qaReads = 0;
  const client = { async query(sql: string) {
    states.push(sql);
    if (sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE' || sql === "SET LOCAL app.profile_authoritative_override = 'on'" || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (sql.startsWith('INSERT')) return { rowCount: 1 };
    if (sql.startsWith('DELETE')) return {};
    if (sql.includes('FROM public."profiles"')) return { rows: [{ applywizz_id: 'scoped' }] };
    if (sql.includes('FROM public."gh_candidate_qa_bank"')) {
      qaReads++;
      const row = { applywizz_id: 'scoped', question_fingerprint: qaReads === 1 ? 'expected' : 'stale', question_label: null, field_type: null, value: 'answer', source: null, confidence: null, embedding: null };
      return { rows: [row] };
    }
    assert.fail(`unexpected query: ${sql}`);
  } };
  await assert.rejects(importSnapshotTransaction(client, [profile], [qa], true), /key set or values differ/);
  assert.equal(states.at(-1), 'ROLLBACK');
});
