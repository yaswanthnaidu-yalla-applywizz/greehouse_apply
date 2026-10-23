/**
 * @fileoverview Standalone runner to scan and resolve the first 5 applications from a CSV
 * using Anthropic Claude Haiku (claude-haiku-5-5 -> claude-haiku-4-5 -> claude-3-5-haiku-latest)
 * for Tier 5 LLM resolution.
 *
 * Local-only execution: does NOT mutate gh_candidate_applications in Supabase.
 * Results are exported to output/resolved_first_5_haiku.json.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { PlaywrightScanner } from '../src/scanner/playwrightScanner.js';
import { resolveShortlink } from '../src/scanner/csvDeduplicator.js';
import { getProfile, profileRowToCandidateProfile, type ProfileRow } from '../src/db/profiles.js';
import { getOrParseResume, type ResumeParsedRow, resolveTier2 } from '../src/resolver/tier2ResumeParse.js';
import { findAnswersByCandidate, type QABankRow } from '../src/db/qaBank.js';
import {
  resolvePreTierField,
  resolveStructuredEeocField,
  alignResolvedChoice,
  isUnsupportedUuidAnswer,
} from '../src/resolver/answerResolver.js';
import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import { findSemanticMatch } from '../src/resolver/semanticSearch.js';
import { resolveTier3 } from '../src/resolver/tier3FuzzyMatch.js';
import {
  LLMSynthesizer,
  buildSinglePrompt,
  getEffectiveFieldOptions,
  type JobContext,
} from '../src/resolver/llmSynthesizer.js';
import { enforceCorporatePolicy, CORPORATE_POLICY_PROMPT_GUIDELINES } from '../src/resolver/corporatePolicies.js';
import { isPhoneNumberField, resumeAnswerMatchesPhone } from '../src/resolver/candidateEvidence.js';
import type { ScannedField, ResolvedField, ScannedJobTemplate, ApplyWizzCandidateProfile } from '../src/types/index.js';
import { createLogger } from '../src/utils/logger.js';

// Load environment variables dynamically
dotenv.config();

const log = createLogger('Resolve-First-5-Haiku');

// Read CLAUDE_API_KEY dynamically, handling any potential trailing key spaces in .env
function getClaudeApiKey(): string {
  if (process.env.CLAUDE_API_KEY && process.env.CLAUDE_API_KEY.trim()) {
    return process.env.CLAUDE_API_KEY.trim();
  }
  // Check process.env keys in case of trailing whitespace
  for (const [key, value] of Object.entries(process.env)) {
    if (key.trim() === 'CLAUDE_API_KEY' && value && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function getClaudeWorkspaceId(): string | undefined {
  if (process.env.ANTHROPIC_WORKSPACE_ID && process.env.ANTHROPIC_WORKSPACE_ID.trim()) {
    return process.env.ANTHROPIC_WORKSPACE_ID.trim();
  }
  if (process.env.CLAUDE_WORKSPACE_ID && process.env.CLAUDE_WORKSPACE_ID.trim()) {
    return process.env.CLAUDE_WORKSPACE_ID.trim();
  }
  for (const [key, value] of Object.entries(process.env)) {
    const trimmedKey = key.trim();
    if ((trimmedKey === 'ANTHROPIC_WORKSPACE_ID' || trimmedKey === 'CLAUDE_WORKSPACE_ID') && value && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

interface CsvRow {
  taskId: string;
  companyName: string;
  jobUrl: string;
  score: string;
  leadName: string;
  applywizzId: string;
}

function parseFirstNRowsFromCsv(csvPath: string, n = 5): CsvRow[] {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found at: ${csvPath}`);
  }

  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) {
    throw new Error(`CSV file contains no data rows: ${csvPath}`);
  }

  const rows: CsvRow[] = [];
  // Line 0 is header
  for (let i = 1; i < lines.length && rows.length < n; i++) {
    const line = lines[i];
    // Basic CSV line parser handling quoted values
    const regex = /(?:,|\n|^)("(?:(?:"")*[^"]*)*"|[^",\n]*|(?:\n|$))/g;
    const matches: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      let val = match[1] || '';
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1).replace(/""/g, '"');
      }
      matches.push(val.trim());
      if (regex.lastIndex >= line.length) break;
    }

    if (matches.length >= 6) {
      rows.push({
        taskId: matches[0],
        companyName: matches[1],
        jobUrl: matches[2],
        score: matches[3],
        leadName: matches[4],
        applywizzId: matches[5],
      });
    }
  }

  return rows;
}

const HAIKU_MODELS = [
  'claude-haiku-5-5',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-3-5-haiku-latest',
  'claude-3-5-haiku-20241022',
];

let workingHaikuModel: string | null = null;

async function callAnthropicHaiku(
  prompt: string,
  systemPrompt: string,
  apiKey: string,
  workspaceId?: string
): Promise<{ rawText: string; modelUsed: string }> {
  const modelsToTry = workingHaikuModel ? [workingHaikuModel, ...HAIKU_MODELS.filter((m) => m !== workingHaikuModel)] : HAIKU_MODELS;

  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (workspaceId) {
    headers['anthropic-workspace-id'] = workspaceId;
  }

  let lastError: Error | null = null;

  for (const model of modelsToTry) {
    try {
      const requestBody: Record<string, unknown> = {
        model,
        max_tokens: 350,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      };
      // 5.5 generation deprecates temperature parameter
      if (!model.includes('5-5') && !model.includes('5.5')) {
        requestBody.temperature = 0.2;
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let parsedError: any = {};
        try {
          parsedError = JSON.parse(errorBody);
        } catch {
          parsedError = { raw: errorBody };
        }

        const errorMessage = parsedError?.error?.message || errorBody;

        // If the model is not found or unsupported, fall back to the next model
        if (
          response.status === 404 ||
          (response.status === 400 && /model|not_found|unsupported/i.test(errorMessage))
        ) {
          log.warn(`⚠️ Model "${model}" not available (${errorMessage}). Attempting fallback...`);
          lastError = new Error(`Model ${model} unavailable: ${errorMessage}`);
          continue;
        }

        // If workspace error, inform user clearly
        if (/workspace/i.test(errorMessage)) {
          throw new Error(
            `Anthropic API Key Error: ${errorMessage}. ` +
            `Please provide ANTHROPIC_WORKSPACE_ID in your .env or use a workspace-scoped key.`
          );
        }

        throw new Error(`Anthropic API returned HTTP ${response.status}: ${errorMessage}`);
      }

      const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
      const rawText = data.content?.find((c) => c.type === 'text')?.text || '';

      if (!workingHaikuModel) {
        workingHaikuModel = model;
        log.info(`✅ Successfully locked active Claude Haiku model: "${workingHaikuModel}"`);
      }

      return { rawText, modelUsed: model };
    } catch (err: any) {
      if (err.message?.includes('Anthropic API Key Error')) {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError || new Error('All Claude Haiku model attempts failed.');
}

async function resolveFieldWithWaterfall(
  field: ScannedField,
  applywizzId: string,
  profile: ProfileRow | null,
  candidateProfile: ApplyWizzCandidateProfile,
  parsedResume: ResumeParsedRow | null,
  qaEntries: QABankRow[],
  jobContext: JobContext,
  apiKey: string,
  workspaceId?: string,
  synthesizer?: LLMSynthesizer
): Promise<ResolvedField> {
  const isRequired = Boolean(field.isRequired || (field as any).required || (field as any).is_required);
  const resolutionField = field.optionsComplete === false ? { ...field, options: undefined } : field;

  // 1. Pre-Tier
  const preTier = resolvePreTierField(field, profile, isRequired);
  if (preTier) return preTier;

  // Never fill cover letters
  if (/cover\s*letter|cover_letter/i.test(`${field.name} ${field.fieldId} ${field.label}`)) {
    return {
      fieldId: field.fieldId,
      name: field.name,
      type: field.type,
      label: field.label,
      value: '',
      source: 'supabase',
      resolvedByTier: 1,
      confidence: 1.0,
      isRequired,
    };
  }

  // 2. Structured EEOC
  const structuredEeoc = resolveStructuredEeocField(resolutionField, profile, isRequired);
  if (structuredEeoc) return structuredEeoc;

  // 3. Tier 1: Supabase Profile & Exact QA Bank
  const tier1 = await resolveTier1(applywizzId, resolutionField, profile);
  if (tier1 && tier1.value && tier1.value.trim().length > 0) {
    return { ...tier1, isRequired };
  }

  // 4. Tier 2: Resume Parse Cache
  const tier2 = await resolveTier2(applywizzId, resolutionField, parsedResume);
  if (tier2 && tier2.value && tier2.value.trim().length > 0) {
    return { ...tier2, isRequired };
  }

  // 5. Tier 3: Semantic Match
  const semanticMatch = await findSemanticMatch(
    field.label,
    applywizzId,
    resolutionField.type,
    resolutionField.options,
    0.82,
    profile
  );
  if (semanticMatch && semanticMatch.value && semanticMatch.value.trim().length > 0) {
    const phone = isPhoneNumberField(field)
      ? resumeAnswerMatchesPhone(semanticMatch.value, parsedResume?.structured, parsedResume?.raw_text)
      : semanticMatch.value;
    if (phone) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: phone,
        source: 'semantic',
        resolvedByTier: 3,
        confidence: semanticMatch.confidence,
        isRequired,
      };
    }
  }

  // 6. Tier 4: Fuzzy Match
  const tier4 = await resolveTier3(applywizzId, resolutionField, qaEntries, profile);
  if (tier4 && tier4.value && tier4.value.trim().length > 0 && !isUnsupportedUuidAnswer(field, tier4.value)) {
    return { ...tier4, resolvedByTier: 4, isRequired };
  }

  // 7. Tier 5: Anthropic Claude Haiku
  if (apiKey) {
    try {
      const choiceOptions = getEffectiveFieldOptions(field);
      const isChoiceField = choiceOptions && choiceOptions.length > 0;
      const incompleteChoice = field.type === 'select' && field.optionsComplete === false;

      const baseSystemMessage = incompleteChoice
        ? 'You are an automated job application assistant. Return only one concise, exact choice label supported by candidate data. The scanned choice list is incomplete; do not invent a value. If candidate data does not support an answer, return NONE.'
        : isChoiceField
        ? 'You are an automated job application assistant. You MUST return exactly one of the provided options. Choose the closest true answer based on candidate data. If none fit, return NONE.'
        : 'You are an automated job application assistant. Be concise and factual. Base your answer only on the candidate profile data provided. Do not invent or assume information not present in the profile. Reply as JSON only: {"answer":"<text>","confidence":<0.0-1.0>}. NEVER return markdown or explanatory text.';

      const systemPrompt = `${baseSystemMessage}\n\n${CORPORATE_POLICY_PROMPT_GUIDELINES}`;
      const prompt = buildSinglePrompt(field, candidateProfile, parsedResume?.raw_text || '', jobContext);

      const { rawText, modelUsed } = await callAnthropicHaiku(prompt, systemPrompt, apiKey, workspaceId);

      if (synthesizer) {
        const finalized = synthesizer.finalizeRawAnswer(rawText, field, candidateProfile, jobContext, {
          defaultConfidenceIfMissing: 0.85,
        });
        if (finalized.value && finalized.value.trim().length > 0 && finalized.source !== 'unresolved') {
          return {
            ...finalized,
            resolvedByTier: 5,
            metadata: {
              ...(finalized.metadata || {}),
              modelUsed,
            } as any,
            isRequired,
          };
        }
      }
    } catch (err: any) {
      log.warn(`[Tier 5 Haiku] Field "${field.label}" failed: ${err.message}`);
    }
  }

  // Unresolved Fallback
  return {
    fieldId: field.fieldId,
    name: field.name,
    type: field.type,
    label: field.label,
    value: '',
    source: 'unresolved',
    resolvedByTier: null,
    confidence: 0,
    isRequired,
  };
}

export async function run(): Promise<void> {
  const csvPath = 'C:\\Users\\yaswa\\Downloads\\greenhouse-jobs-2026-10-22.csv';
  const apiKey = getClaudeApiKey();
  const workspaceId = getClaudeWorkspaceId();

  log.info('================================================================');
  log.info('  First 5 Applications Resolution Runner (Claude Haiku Tier 5)');
  log.info('================================================================');
  log.info(`• CSV Path:      ${csvPath}`);
  log.info(`• Claude API Key: ${apiKey ? `Found (${apiKey.slice(0, 10)}...)` : '❌ Missing in .env'}`);
  if (workspaceId) {
    log.info(`• Workspace ID:  ${workspaceId}`);
  }
  log.info(`• Preferred LLM: claude-haiku-5-5 (with automatic 4.5/3.5 fallback)`);
  log.info(`• DB Mutations:  DISABLED (Local output only)`);
  log.info('================================================================\n');

  if (!apiKey) {
    throw new Error('CLAUDE_API_KEY is not defined in .env.');
  }

  // 1. Parse CSV
  log.info('📂 [Step 1/4] Reading first 5 rows from CSV...');
  const rows = parseFirstNRowsFromCsv(csvPath, 5);
  log.info(`✅ Loaded ${rows.length} rows:`);
  rows.forEach((r, idx) => {
    log.info(`   ${idx + 1}. [${r.companyName}] ${r.jobUrl} (Candidate: ${r.applywizzId})`);
  });

  // 2. Resolve Shortlinks & Canonical URLs
  log.info('\n🔗 [Step 2/4] Resolving canonical URLs and shortlinks...');
  const canonicalMap = new Map<string, string>();
  for (const row of rows) {
    const canonical = await resolveShortlink(row.jobUrl);
    canonicalMap.set(row.jobUrl, canonical);
    if (canonical !== row.jobUrl) {
      log.info(`   • Resolved: ${row.jobUrl} -> ${canonical}`);
    }
  }

  // 3. Scan Forms with Playwright
  log.info('\n🌐 [Step 3/4] Scanning Greenhouse forms with Playwright (Headless)...');
  const uniqueUrls = Array.from(new Set(canonicalMap.values()));
  const scanner = new PlaywrightScanner({ headless: true, timeoutMs: 35000 });
  const scannedTemplates = await scanner.scanUniqueUrls(uniqueUrls);
  const templateMap = new Map<string, ScannedJobTemplate>();
  for (const t of scannedTemplates) {
    templateMap.set(t.jobUrl, t);
    log.info(`   • Scanned "${t.companyName || 'Unknown'}" - "${t.jobTitle || 'Unknown'}": ${t.fields.length} form fields`);
  }

  // 4. Resolve Fields
  log.info('\n⚙️ [Step 4/4] Executing 5-Tier Waterfall Resolution with Claude Haiku...');
  const synthesizer = new LLMSynthesizer();
  const results: any[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const canonicalUrl = canonicalMap.get(row.jobUrl) || row.jobUrl;
    const template = templateMap.get(canonicalUrl);

    log.info(`\n----------------------------------------------------------------`);
    log.info(`Application ${i + 1}/${rows.length}: ${row.companyName} (${row.leadName} - ${row.applywizzId})`);
    log.info(`Job URL: ${canonicalUrl}`);
    log.info(`----------------------------------------------------------------`);

    if (!template || template.isExpired || template.fields.length === 0) {
      log.warn(`⚠️ Job posting unavailable, expired, or has no fields. Skipping field resolution.`);
      results.push({
        taskId: row.taskId,
        companyName: row.companyName,
        jobTitle: template?.jobTitle || '',
        jobUrl: canonicalUrl,
        applywizzId: row.applywizzId,
        leadName: row.leadName,
        status: template?.isExpired ? 'EXPIRED' : 'NO_FIELDS',
        fieldsCount: template?.fields.length || 0,
        resolvedCount: 0,
        tier5Count: 0,
        activeModel: workingHaikuModel || 'none',
        resolvedFields: [],
      });
      continue;
    }

    // Load Candidate Context
    const profile = await getProfile(row.applywizzId);
    const candidateProfile = profile ? profileRowToCandidateProfile(profile) : { applywizzId: row.applywizzId } as any;
    const parsedResume = await getOrParseResume(row.applywizzId);
    const qaEntries = await findAnswersByCandidate(row.applywizzId);

    const jobContext: JobContext = {
      company: template.companyName || row.companyName,
      title: template.jobTitle || 'Software Engineer',
    };

    const resolvedFields: ResolvedField[] = [];

    for (const field of template.fields) {
      const rawResolved = await resolveFieldWithWaterfall(
        field,
        row.applywizzId,
        profile,
        candidateProfile,
        parsedResume,
        qaEntries,
        jobContext,
        apiKey,
        workspaceId,
        synthesizer
      );

      const aligned = alignResolvedChoice(field, rawResolved, getEffectiveFieldOptions(field));
      const enforcedBase = enforceCorporatePolicy(field, aligned);
      const enforced: ResolvedField = {
        ...enforcedBase,
        metadata: {
          ...(enforcedBase.metadata || {}),
          ...(rawResolved.metadata || {}),
        } as any,
      };

      resolvedFields.push(enforced);

      const tierBadge = enforced.resolvedByTier !== null ? `Tier ${enforced.resolvedByTier}` : 'UNRESOLVED';
      const sourceBadge = enforced.source ? `[${enforced.source}]` : '';
      const valPreview = enforced.value.length > 50 ? `${enforced.value.slice(0, 47)}...` : enforced.value;
      log.info(`   • [${tierBadge}] ${sourceBadge} "${field.label}": "${valPreview || '(empty)'}" (conf: ${enforced.confidence})`);
    }

    const resolvedCount = resolvedFields.filter((f) => f.value && f.source !== 'unresolved').length;
    const tier5Count = resolvedFields.filter((f) => f.resolvedByTier === 5).length;

    results.push({
      taskId: row.taskId,
      companyName: template.companyName || row.companyName,
      jobTitle: template.jobTitle,
      jobUrl: canonicalUrl,
      applywizzId: row.applywizzId,
      leadName: row.leadName,
      fieldsCount: template.fields.length,
      resolvedCount,
      tier5Count,
      activeModel: workingHaikuModel || 'none',
      resolvedFields,
    });
  }

  // 5. Export to Local JSON
  const outputDir = path.resolve(process.cwd(), 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const outputPath = path.join(outputDir, 'resolved_first_5_haiku.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');

  log.info('\n================================================================');
  log.info('  Summary & Results');
  log.info('================================================================');
  results.forEach((res, idx) => {
    log.info(`\n[Job ${idx + 1}] ${res.companyName} — ${res.jobTitle || '(No title)'}`);
    log.info(` • URL:           ${res.jobUrl}`);
    log.info(` • Total Fields:  ${res.fieldsCount}`);
    log.info(` • Resolved:      ${res.resolvedCount} / ${res.fieldsCount}`);
    log.info(` • Tier 5 (Haiku): ${res.tier5Count}`);
  });

  log.info(`\n💾 Saved detailed resolution results to: ${outputPath}`);
  log.info('================================================================\n');
}

// Auto-run if executed directly
if (process.argv[1] && process.argv[1].includes('resolveFirst5Haiku')) {
  run().catch((err) => {
    log.error('Fatal error during execution:', err);
    process.exit(1);
  });
}
