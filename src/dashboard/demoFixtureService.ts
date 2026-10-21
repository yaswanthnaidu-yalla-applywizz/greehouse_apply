import fs from 'fs';
import path from 'path';

export const DEMO_APPLYWIZZ_IDS = new Set(['AWL-YASWANTH', 'AWL-YASHANTH', 'AWL-31428']);

export function isDemoCandidateId(applywizzId: string): boolean {
  const clean = (applywizzId || '').trim().toUpperCase();
  return DEMO_APPLYWIZZ_IDS.has(clean);
}

export function findLocalDemoResume(applywizzId: string): string | null {
  const localCandidates = [
    path.resolve(process.cwd(), 'resumes', `${applywizzId}_resume.pdf`),
    path.resolve(process.cwd(), 'resumes', 'AWL-YASHANTH_resume.pdf'),
    path.resolve(process.cwd(), 'resumes', 'AWL-31428_resume.pdf'),
    path.resolve(process.cwd(), 'resumes', 'my-resume.pdf'),
  ];
  return localCandidates.find((p) => fs.existsSync(p)) || null;
}
