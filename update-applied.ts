import pg from 'pg';
import dotenv from 'dotenv';
import { getFadaDatabaseConnectionString } from './src/utils/fadaDatabaseConnectionString.ts';

dotenv.config();

const { Pool } = pg;
const connectionString = getFadaDatabaseConnectionString(process.env);
const pool = new Pool({ connectionString });

const ids = [
  '4f7d2281-c476-49c2-bd91-4c774d4af18f', // IRIS
  '49d37579-5062-4205-b7c5-5419445a2abe', // IRIS
  'b7a6285e-186e-4478-b03d-811cedaf6450', // IRIS
  'e149f305-8cba-4aa6-a3f9-8e8f760b50e1', // Lovable
  'fcc9281c-04d3-4483-ad6a-849bc5d48962', // Lovable
  'e39a00ad-8e41-411d-82db-35cfbd5099ea', // Lovable
  'f14353ed-fa17-434e-8785-ae1a1517067d', // Lovable
  'b16bbf2f-2271-4e82-92e8-a79501b2246e', // BillGO, Inc.
  'e41d5bd5-1313-4283-9b31-300f5b7b146e', // BillGO, Inc.
  '3851c658-b077-4598-aa16-16f416ca0f6f', // HUMAN
  'b208c6bb-a70c-49d4-8069-22a27666ee07', // HUMAN
  'e70fd898-b02e-45fb-b0eb-ae97a1de84f9', // Cohere
  '217192f5-dab4-4e02-84d5-9ced0734251f', // algo1
];

async function run() {
  try {
    const res = await pool.query(`
      UPDATE gh_candidate_applications
      SET 
        status = 'APPLIED',
        proof_web_url = COALESCE(proof_web_url, proof_failed_url),
        submitted_at = COALESCE(submitted_at, proof_failed_captured_at, NOW()),
        error_message = NULL
      WHERE id = ANY($1::uuid[])
      RETURNING id, company_name, job_title, status, submitted_at, proof_web_url;
    `, [ids]);

    console.log(`Successfully updated ${res.rowCount} applications to APPLIED:`);
    res.rows.forEach(r => {
      console.log(`- ${r.id} | ${r.company_name} | ${r.job_title} | status: ${r.status}`);
    });
  } catch (err: any) {
    console.error('Update failed:', err.message);
  } finally {
    await pool.end();
  }
}

run();
