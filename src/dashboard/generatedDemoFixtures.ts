/**
 * Optional admin demo fixtures generated from a real pipeline run (AWL-31428).
 * Populated by: npm run demo:fixture-31428
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config/env.js';
import {
  akshithaApplications,
  akshithaSegment,
  akshithaTemplates,
  AKSHITHA_APPLYWIZZ_ID,
} from './akshithaDemoFixtures.js';
import type {
  CandidateJobApplication,
  CandidateSegment,
  ScannedField,
  ScannedJobTemplate,
} from '../types/index.js';

export const GENERATED_DEMO_APPLYWIZZ_ID = AKSHITHA_APPLYWIZZ_ID;
export { AKSHITHA_APPLYWIZZ_ID };

export interface GeneratedDemoFixtureFile {
  applywizzId: string;
  generatedAt: string;
  segment: CandidateSegment;
  applications: CandidateJobApplication[];
  templates: ScannedJobTemplate[];
}

export function getGeneratedDemoFixturePath(): string {
  return path.resolve(process.cwd(), 'src/dashboard/fixtures/AWL-31428.generated.json');
}

export function readGeneratedDemoFixtures(): GeneratedDemoFixtureFile | null {
  const fixturePath = getGeneratedDemoFixturePath();
  if (!fs.existsSync(fixturePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as GeneratedDemoFixtureFile;
    if (!parsed?.segment || !Array.isArray(parsed.applications)) {
      return null;
    }
    return parsed;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Demo Fixtures] Failed to read ${fixturePath}: ${message}`);
    return null;
  }
}

export function loadSecondaryDemoArtifacts(): {
  segment: CandidateSegment | null;
  applications: CandidateJobApplication[];
  templates: ScannedJobTemplate[];
} {
  const fixture = readGeneratedDemoFixtures();
  if (fixture) {
    return {
      segment: fixture.segment,
      applications: fixture.applications,
      templates: fixture.templates,
    };
  }
  return {
    segment: akshithaSegment,
    applications: akshithaApplications,
    templates: akshithaTemplates,
  };
}

function templatesFromApplications(apps: CandidateJobApplication[]): ScannedJobTemplate[] {
  return apps.map((app) => ({
    jobUrl: app.jobUrl,
    companyName: app.companyName,
    jobTitle: app.jobTitle,
    fields: app.resolvedFields.map((f) => ({
      fieldId: f.fieldId,
      name: f.name,
      type: f.type as ScannedField['type'],
      label: f.label,
      isRequired: true,
    })),
    scannedAt: new Date().toISOString(),
    isExpired: false,
  }));
}

/**
 * Builds fixture JSON from pipeline output/ artifacts for one applywizz id.
 */
export function buildDemoFixtureFromOutput(
  applywizzId: string,
  outputDir: string = config.OUTPUT_DIR
): GeneratedDemoFixtureFile {
  const resolvedOutputDir = path.resolve(process.cwd(), outputDir);
  const segmentsPath = path.join(resolvedOutputDir, 'candidate_segments.json');
  const applicationsPath = path.join(resolvedOutputDir, 'resolved_applications.json');
  const templatesPath = path.join(resolvedOutputDir, 'scanned_jobs.json');

  if (!fs.existsSync(segmentsPath)) {
    throw new Error(`Missing ${segmentsPath}. Run the pipeline for ${applywizzId} first.`);
  }
  if (!fs.existsSync(applicationsPath)) {
    throw new Error(`Missing ${applicationsPath}. Run resolution for ${applywizzId} first.`);
  }

  const targetId = applywizzId.trim().toUpperCase();
  const segments = JSON.parse(fs.readFileSync(segmentsPath, 'utf-8')) as CandidateSegment[];
  const segment = segments.find((s) => (s.applywizzId || '').trim().toUpperCase() === targetId);
  if (!segment) {
    throw new Error(`No segment for ${applywizzId} in ${segmentsPath}`);
  }

  const allApplications = JSON.parse(fs.readFileSync(applicationsPath, 'utf-8')) as CandidateJobApplication[];
  const applications = allApplications.filter(
    (a) => (a.applywizzId || '').trim().toUpperCase() === targetId
  );
  if (applications.length === 0) {
    throw new Error(`No resolved applications for ${applywizzId} in ${applicationsPath}`);
  }

  const jobUrls = new Set<string>();
  for (const job of segment.jobs || []) {
    if (job.canonicalUrl) jobUrls.add(job.canonicalUrl);
    if (job.rawUrl) jobUrls.add(job.rawUrl);
  }
  for (const app of applications) {
    if (app.jobUrl) jobUrls.add(app.jobUrl);
  }

  let templates: ScannedJobTemplate[] = [];
  if (fs.existsSync(templatesPath)) {
    const scanned = JSON.parse(fs.readFileSync(templatesPath, 'utf-8')) as ScannedJobTemplate[];
    templates = scanned.filter((t) => jobUrls.has(t.jobUrl));
  }
  if (templates.length === 0) {
    templates = templatesFromApplications(applications);
  }

  return {
    applywizzId: targetId,
    generatedAt: new Date().toISOString(),
    segment,
    applications,
    templates,
  };
}

export function writeGeneratedDemoFixtures(fixture: GeneratedDemoFixtureFile): string {
  const fixturePath = getGeneratedDemoFixturePath();
  const dir = path.dirname(fixturePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf-8');
  return fixturePath;
}
