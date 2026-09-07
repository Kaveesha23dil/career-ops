#!/usr/bin/env node
/**
 * job-cv.mjs — Storage + lookup for the `/career-ops job-cv` mode.
 *
 * The mode file (`modes/job-cv.md`) is where the agent reads the saved job
 * details, tails the `pdf`-mode flow, and generates the tailored CV. This
 * helper owns the deterministic parts: saving job details to `data/jobs/`
 * (JSON, slug-deduped — saving the same company+role twice is a no-op update,
 * never a duplicate), listing saved jobs, and printing one job's details.
 *
 * Usage:
 *   node job-cv.mjs save    --company "<name>" --role "<title>" --jd "<text>"
 *   node job-cv.mjs save    --company "<name>" --role "<title>" --jd-file <path>
 *   node job-cv.mjs list    [--json]
 *   node job-cv.mjs show    --slug <slug>
 *   node job-cv.mjs show    --company <name> --role <title>
 *
 * Flags:
 *   --company <name>     Job company (required for save/show-by-company).
 *   --role <title>       Job title (required for save).
 *   --jd <text>          Job description text. Use --jd-file for long text.
 *   --jd-file <path>     Read the job description from a file (one of --jd /
 *                        --jd-file is required for save).
 *   --slug <slug>        Job slug, kebab-case of "company role".
 *   --json               `list` prints machine-readable JSON.
 *   --help / -h          This help text.
 *
 * Output: human-readable by default; `list --json` emits
 *   { "jobs": [{ "slug", "company", "role", "saved_at", "word_count" }] }.
 *
 * Test isolation: CAREER_OPS_JOBS_DIR overrides the jobs directory.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CAREER_OPS = getCareerOpsRoot();
const JOBS_DIR = process.env.CAREER_OPS_JOBS_DIR || join(CAREER_OPS, 'data', 'jobs');

const USAGE = `Usage:
  node job-cv.mjs save    --company "<name>" --role "<title>" --jd "<text>"
  node job-cv.mjs save    --company "<name>" --role "<title>" --jd-file <path>
  node job-cv.mjs list    [--json]
  node job-cv.mjs show    --slug <slug>
  node job-cv.mjs show    --company <name> --role <title>
  node job-cv.mjs --help  # print this usage block and exit (-h is an alias)`;

// Normalize "Google" + "Senior Software Engineer" -> "google-senior-software-engineer".
// Kebab-case, lowercase, non-alphanumerics become single hyphens. Empty input
// yields '' so callers can treat it as "slug unavailable".
export function slugify(company, role) {
  const text = `${company || ''} ${role || ''}`;
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// A slug is the identity of a saved job. Company+role are stored for display;
// the slug (not the display string) is the key used for save-dedup, listing,
// and generation. This lets the agent save a job, then regenerate the CV next
// session just from the slug.
export function jobFilename(slug) {
  return join(JOBS_DIR, `${slug}.json`);
}

export function readJob(slug) {
  const file = jobFilename(slug);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new Error(`job-cv: could not parse saved job "${slug}": ${e.message}`);
  }
}

export function listJobs() {
  if (!existsSync(JOBS_DIR)) return [];
  return readdirSync(JOBS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readJob(f.slice(0, -'.json'.length)))
    .filter(Boolean)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

// Save a job payload under its slug. Write the temp file first, then copy over
// the target, and clean up the temp in a finally — so a crash mid-write never
// leaves a half-written job where the reader looks.
export function saveJob(job) {
  if (!job || !job.company || !job.role || !job.slug) {
    throw new Error('job-cv: save requires { company, role, slug }');
  }
  mkdirSync(JOBS_DIR, { recursive: true });
  const payload = {
    company: job.company,
    role: job.role,
    slug: job.slug,
    saved_at: job.saved_at || new Date().toISOString(),
    job_description: job.job_description || '',
  };
  const target = jobFilename(job.slug);
  const serialized = JSON.stringify(payload, null, 2) + '\n';
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, serialized, 'utf-8');
  try {
    writeFileSync(target, serialized, 'utf-8');
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
  return payload;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.find(a => !a.startsWith('-'));

  if (!cmd || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }

  const flag = name => {
    const i = args.indexOf(name);
    if (i === -1) return null;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`job-cv: missing value for ${name}`);
    return v;
  };

  try {
    if (cmd === 'save') {
      const company = flag('--company');
      const role = flag('--role');
      const jd = flag('--jd');
      const jdFile = flag('--jd-file');
      if (!company || !role) throw new Error('job-cv: save requires --company and --role');
      if (!jd && !jdFile) throw new Error('job-cv: save requires --jd or --jd-file');
      if (jd && jdFile) throw new Error('job-cv: supply either --jd or --jd-file, not both');
      const jobDescription = jd !== null ? jd : readFileSync(jdFile, 'utf-8');
      if (!jobDescription.trim()) throw new Error('job-cv: job description is empty');
      const slug = slugify(company, role);
      const previous = readJob(slug);
      const saved = saveJob({ company, role, slug, job_description: jobDescription });
      console.log(JSON.stringify({
        status: previous ? 'updated' : 'saved',
        slug,
        company,
        role,
        saved_at: saved.saved_at,
        word_count: saved.job_description.trim().split(/\s+/).length,
      }, null, 2));
    } else if (cmd === 'list') {
      const jobs = listJobs();
      if (args.includes('--json')) {
        console.log(JSON.stringify({
          jobs: jobs.map(j => ({ slug: j.slug, company: j.company, role: j.role, saved_at: j.saved_at, word_count: (j.job_description || '').trim().split(/\s+/).length })),
        }, null, 2));
      } else if (jobs.length === 0) {
        console.log('No saved jobs. Save one first: node job-cv.mjs save --company "X" --role "Y" --jd "..."');
      } else {
        for (const j of jobs) {
          console.log(`${j.slug}\t${j.company}\t${j.role}\t${j.saved_at}`);
        }
      }
    } else if (cmd === 'show') {
      const slug = flag('--slug');
      const company = flag('--company');
      const role = flag('--role');
      const resolved = slug || (company ? slugify(company, role || '') : null);
      if (!resolved) throw new Error('job-cv: show requires --slug, or --company');
      const job = readJob(resolved);
      if (!job) throw new Error(`job-cv: no saved job for slug "${resolved}"`);
      console.log(JSON.stringify(job, null, 2));
    } else {
      throw new Error(`job-cv: unknown command "${cmd}"`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

// Only run main() when invoked directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  main().catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}