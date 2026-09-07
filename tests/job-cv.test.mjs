// tests/job-cv.test.mjs — save/list/show of job details (slug-deduped JSON under data/jobs/)
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail } from './helpers.mjs';

console.log('\njob-cv.mjs — save/list/show job details');

// Isolated jobs dir: never touches the user's real data/jobs/
const jobsDir = mkdtempSync(join(tmpdir(), 'job-cv-test-'));
const prior = process.env.CAREER_OPS_JOBS_DIR;
process.env.CAREER_OPS_JOBS_DIR = jobsDir;

// job-cv.mjs resolves CAREER_OPS_JOBS_DIR at import time, so import it AFTER
// setting the override above.
const { slugify, saveJob, listJobs, readJob, jobFilename } = await import('../job-cv.mjs');

let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) pass(msg);
  else fail(msg);
};

// --- slugify ---------------------------------------------------------------
ok(slugify('Google', 'Senior Software Engineer') === 'google-senior-software-engineer',
  'slugify kebab-cases company + role');
ok(slugify('Acme Inc', 'SF. / NYC') === 'acme-inc-sf-nyc',
  'slugify collapses non-alphanumerics into single hyphens');
ok(slugify('', 'Engineer') === 'engineer',
  'slugify tolerates an empty company');
ok(slugify('Café GmbH', 'ML Engineer') === 'caf-gmbh-ml-engineer',
  'slugify keeps it ASCII-safe (accents dropped)');
ok(typeof slugify('データ', 'エンジニア') === 'string' && slugify('データ', 'エンジニア').length >= 0,
  'slugify tolerates non-Latin names without raising');

// --- save ------------------------------------------------------------------
const saved = saveJob({
  company: 'Acme Inc',
  role: 'Senior Data Engineer',
  slug: slugify('Acme Inc', 'Senior Data Engineer'),
  job_description: 'Build Spark pipelines.\nAirflow scheduling.',
});
ok(saved.slug === 'acme-inc-senior-data-engineer', 'save returns the payload');
ok(existsSync(jobFilename('acme-inc-senior-data-engineer')), 'save writes data/jobs/<slug>.json');

// --- list -------------------------------------------------------------------
ok(listJobs().length === 1, 'list sees the saved job');
ok(listJobs()[0].company === 'Acme Inc', 'list carries company and role');
saveJob({ company: 'Beta', role: 'ML Ops Lead', slug: slugify('Beta', 'ML Ops Lead'), job_description: 'JD' });
ok(listJobs().length === 2, 'list includes both jobs');
ok(listJobs()[0].slug === 'acme-inc-senior-data-engineer', 'list sorts by slug lexicographically');

// --- slug-dedup: same company + role updates, never duplicates --------------
saveJob({
  company: 'Acme Inc',
  role: 'Senior Data Engineer',
  slug: slugify('Acme Inc', 'Senior Data Engineer'),
  job_description: 'Updated text.',
});
ok(listJobs().filter(j => j.slug === 'acme-inc-senior-data-engineer').length === 1,
  're-save does not duplicate');
ok(readJob('acme-inc-senior-data-engineer').job_description === 'Updated text.',
  're-save updates the stored description');

// --- readJob ----------------------------------------------------------------
ok(readJob('does-not-exist') === null, 'readJob returns null for a missing slug');
ok(typeof readJob('acme-inc-senior-data-engineer').saved_at === 'string',
  'saved jobs carry a saved_at timestamp');

// --- file hygiene -----------------------------------------------------------
const files = readdirSync(jobsDir);
ok(files.every(f => f.endsWith('.json')), 'no temp files left behind in the jobs dir');
ok(listJobs().length === 2, 'list reflects exactly the saved jobs');

console.log(`job-cv.test: ${checks} checks`);

process.env.CAREER_OPS_JOBS_DIR = prior;
rmSync(jobsDir, { recursive: true, force: true });