import { PlaywrightScanner } from "./src/scanner/playwrightScanner.js";
import { AnswerResolver } from "./src/resolver/answerResolver.js";

const NEW_URL = "https://job-boards.greenhouse.io/internshiplist2000/jobs/5376578008";
const APPLYWIZZ_ID = "AWL-YASWANTH";
const MAX_QUESTIONS = 23;

(async () => {
  console.log("=== STEP 1: Scanning URL ===");
  const scanner = new PlaywrightScanner({ workerPoolSize: 1 });
  const templates = await scanner.scanUniqueUrls([NEW_URL]);
  const template = templates[0];

  if (!template) { console.error("ERROR: No template"); process.exit(1); }

  console.log("Job Title:", template.jobTitle);
  console.log("Company:", template.companyName);
  console.log("Expired:", template.isExpired);
  console.log("Field count:", template.fields.length);

  if (template.isExpired) { console.error("ERROR: Expired"); process.exit(1); }
  if (template.fields.length >= MAX_QUESTIONS) { console.error("ERROR: Too many fields:", template.fields.length); process.exit(1); }

  console.log("\n--- SCANNED FIELDS ---");
  for (const f of template.fields) {
    console.log(`  [${f.type}] "${f.label}" name=${f.name} id=${f.fieldId} required=${f.isRequired}`);
  }

  console.log("\n=== STEP 2: Resolving for", APPLYWIZZ_ID, "===");
  const resolver = new AnswerResolver();
  const app = await resolver.resolveJobApplication(APPLYWIZZ_ID, template);

  console.log("\n--- RESOLVED FIELDS ---");
  for (const f of app.resolvedFields) {
    console.log(`  [Tier${f.resolvedByTier ?? "x"}|${f.source}] "${f.label}" => "${f.value}"`);
  }

  console.log("\nTEMPLATE_META=" + JSON.stringify({ jobTitle: template.jobTitle, companyName: template.companyName, jobUrl: template.jobUrl }));
  console.log("SCANNED_JSON=" + JSON.stringify(template.fields));
  console.log("RESOLVED_JSON=" + JSON.stringify(app.resolvedFields));
  console.log("=== DONE fields=" + template.fields.length + " ===");
  process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
