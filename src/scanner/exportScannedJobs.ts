/**
 * @fileoverview Exporter for Scanned Greenhouse Job Application Templates.
 *
 * Implements Branch 1 serialization of `ScannedJobTemplate[]` objects to structured JSON
 * (`output/scanned_jobs.json`) and flattened CSV (`output/scanned_jobs.csv`).
 *
 * References:
 * - 02-trd.md (Section 3.2)
 * - 03-workflow.md (Step 2.4)
 * - 05-backend-schema.md (Section 1.2)
 */

import fs from 'fs';
import path from 'path';
import * as fastCsv from 'fast-csv';
import { config } from '../config/env.js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import type { ScannedJobTemplate } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { isPipelineCompactLogging } from '../utils/pipelineLogging.js';

const log = createLogger('Export Scanned Jobs');

/**
 * Result object returned by `exportScannedJobs` with absolute output paths.
 */
export interface ExportResult {
  /** Path to the written JSON file */
  jsonPath: string;
  /** Path to the written CSV file */
  csvPath: string;
  /** Total number of job templates exported */
  totalJobs: number;
  /** Total number of individual field rows exported to CSV */
  totalFieldRows: number;
}

/**
 * Flattened row representation for `scanned_jobs.csv`.
 */
export interface ScannedJobCsvRow {
  jobUrl: string;
  companyName: string;
  jobTitle: string;
  scannedAt: string;
  isExpired: string;
  fieldId: string;
  fieldName: string;
  fieldType: string;
  label: string;
  isRequired: string;
  options: string;
  section: string;
  selector: string;
}

/**
 * Serializes an array of `ScannedJobTemplate` records to structured JSON and flattened CSV.
 *
 * @param templates - Array of scanned job templates from PlaywrightScanner.
 * @param outputDir - Destination directory (defaults to `config.OUTPUT_DIR` or `./output`).
 * @returns Promise resolving to an ExportResult with file paths and record counts.
 *
 * @throws Error if output directory cannot be created or file writing fails.
 */
export async function exportScannedJobs(
  templates: ScannedJobTemplate[],
  outputDir: string = config.OUTPUT_DIR
): Promise<ExportResult> {
  const resolvedDir = path.resolve(process.cwd(), outputDir);

  // Ensure output directory exists
  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  const jsonPath = path.join(resolvedDir, 'scanned_jobs.json');
  const csvPath = path.join(resolvedDir, 'scanned_jobs.csv');

  const compact = isPipelineCompactLogging();

  // 1. Write Full Structured JSON
  const jsonContent = JSON.stringify(templates, null, 2);
  await fs.promises.writeFile(jsonPath, jsonContent, 'utf-8');
  const jsonStats = fs.statSync(jsonPath);
  if (!compact) {
    log.info(`[Export Scanned Jobs] 💾 Writing scanned job outputs to: ${resolvedDir}`);
    log.info(`[Export Scanned Jobs] ✅ JSON written: ${jsonPath} (${(jsonStats.size / 1024).toFixed(1)} KB)`);
  }

  let dbTemplatesPersisted = 0;
  if (isSupabaseConfigured() && templates.length > 0) {
    const BATCH_SIZE = 50;
    const totalBatches = Math.ceil(templates.length / BATCH_SIZE);
    const supabase = getDbClient();
    let persisted = 0;

    for (let i = 0; i < templates.length; i += BATCH_SIZE) {
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const chunk = templates.slice(i, i + BATCH_SIZE);
      const rows = chunk.map((template) => ({
        job_url: template.jobUrl,
        company_name: template.companyName || null,
        job_title: template.jobTitle || null,
        fields_schema: template.fields || [],
        is_expired: Boolean(template.isExpired),
        scanned_at: template.scannedAt || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));

      try {
        const { error } = await supabase
          .from('gh_scanned_job_templates')
          .upsert(rows, { onConflict: 'job_url' })
          .abortSignal(AbortSignal.timeout(30000));

        if (error) {
          log.warn(
            `[Export Scanned Jobs] ⚠️ Could not upsert batch ${batchNum}/${totalBatches} to scanned_job_templates: ${error.message}`
          );
        } else {
          persisted += chunk.length;
          log.info(`[Scanner] upserted batch ${batchNum}/${totalBatches}`);
        }
      } catch (err: any) {
        log.warn(
          `[Export Scanned Jobs] ⚠️ Could not upsert batch ${batchNum}/${totalBatches} to scanned_job_templates: ${err?.message || err}`
        );
      }
    }
    dbTemplatesPersisted = persisted;
    if (!compact) {
      log.info(
        `[Export Scanned Jobs] ✅ Upserted ${persisted}/${templates.length} templates to scanned_job_templates (fields_schema)`
      );
    }
  }

  // 2. Flatten Templates to CSV Rows
  const csvRows: ScannedJobCsvRow[] = [];

  for (const template of templates) {
    if (!template.fields || template.fields.length === 0) {
      // For expired or fieldless jobs, output a single status row
      csvRows.push({
        jobUrl: template.jobUrl,
        companyName: template.companyName || '',
        jobTitle: template.jobTitle || '',
        scannedAt: template.scannedAt,
        isExpired: String(template.isExpired),
        fieldId: '',
        fieldName: '',
        fieldType: '',
        label: template.isExpired ? '[Job Expired / Closed]' : '',
        isRequired: 'false',
        options: '',
        section: '',
        selector: '',
      });
    } else {
      for (const field of template.fields) {
        csvRows.push({
          jobUrl: template.jobUrl,
          companyName: template.companyName || '',
          jobTitle: template.jobTitle || '',
          scannedAt: template.scannedAt,
          isExpired: String(template.isExpired),
          fieldId: field.fieldId,
          fieldName: field.name,
          fieldType: field.type,
          label: field.label,
          isRequired: String(field.isRequired),
          options: field.options ? field.options.join(' | ') : '',
          section: field.metadata?.section || '',
          selector: field.metadata?.selector || '',
        });
      }
    }
  }

  // 3. Write CSV with fast-csv stream formatting
  await new Promise<void>((resolve, reject) => {
    fastCsv
      .writeToPath(csvPath, csvRows, { headers: true })
      .on('error', (err) => reject(new Error(`Failed to write CSV: ${err.message}`)))
      .on('finish', () => resolve());
  });

  const csvStats = fs.statSync(csvPath);
  if (compact) {
    const persistedNote =
      isSupabaseConfigured() && templates.length > 0 ? ` db_templates=${dbTemplatesPersisted}/${templates.length}` : '';
    log.info(
      `[Export Scanned Jobs] export jobs=${templates.length} field_rows=${csvRows.length.toLocaleString()} json_kb=${(jsonStats.size / 1024).toFixed(1)} csv_kb=${(csvStats.size / 1024).toFixed(1)}${persistedNote}`
    );
  } else {
    log.info(
      `[Export Scanned Jobs] ✅ CSV written: ${csvPath} (${csvRows.length.toLocaleString()} rows, ${(csvStats.size / 1024).toFixed(1)} KB)`
    );
  }

  return {
    jsonPath,
    csvPath,
    totalJobs: templates.length,
    totalFieldRows: csvRows.length,
  };
}
