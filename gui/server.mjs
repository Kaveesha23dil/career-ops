#!/usr/bin/env node
/**
 * gui/server.mjs — local-first HTTP GUI for career-ops.
 *
 * Zero new dependencies. Serves a single-page app from gui/public and a JSON
 * REST API that manages the user-layer data files (cv.md, config/profile.yml)
 * and drives the EXISTING deterministic toolchain to produce a tailored CV
 * (HTML + PDF) for a given job:
 *
 *   node gui/server.mjs                # http://127.0.0.1:8787
 *   node gui/server.mjs --port 9090    # honour GUI_PORT too
 *
 * Data-root resolution follows the same precedence as every other care-ops
 * script (path-resolver.mjs: CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR / the
 * .career-ops-data marker / the repo root), so the GUI edits exactly the files
 * the CLI evaluates against. The toolchain scripts (build-cv-html.mjs,
 * generate-pdf.mjs) are resolved relative to THIS FILE (the repo), never from
 * the data root.
 *
 * Writes are atomic (temp file + rename) and every overwrite of a user-layer
 * file keeps a single rotating `.bak` next to it — cv.md / profile.yml are
 * gitignored user data with no git recovery underneath.
 *
 * Safety model: binds to 127.0.0.1 only; job/file ids are validated against
 * strict patterns; served PDFs are basename-only from the output directory.
 */

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { tailor, parseCv } from './tailor.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const DATA_ROOT = getCareerOpsRoot();
const OUTPUT_DIR = join(DATA_ROOT, 'output');
const GUI_SCRATCH = join(OUTPUT_DIR, '_gui');
const JOBS_FILE = join(DATA_ROOT, 'data', 'gui', 'jobs.json');

const MAX_CV_BYTES = 200 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PORT = portFromArgs(process.argv.slice(2), process.env.GUI_PORT || 8787);

let yamlLib = null;
try {
  yamlLib = await import('js-yaml');
} catch {
  /* js-yaml missing → YAML validation is skipped, text editing still works */
}

// --- helpers -------------------------------------------------------------

let jobsCache = null;

function readJobs() {
  try {
    if (jobsCache === null) {
      const raw = readFileSync(JOBS_FILE, 'utf8');
      jobsCache = JSON.parse(raw).jobs || [];
    }
  } catch {
    jobsCache = [];
  }
  return jobsCache;
}

function persistJobs(jobs) {
  mkdirSync(dirname(JOBS_FILE), { recursive: true });
  const tmp = JOBS_FILE + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify({ version: 1, jobs }, null, 2), 'utf8');
  renameSync(tmp, JOBS_FILE);
  jobsCache = jobs;
}

function findJob(id) {
  return readJobs().find((j) => j.id === id) || null;
}

function atomicWrite(dest, content) {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    copyFileSync(dest, dest + '.bak');
  }
  const tmp = dest + '.tmp-' + process.pid + '-' + randomUUID().slice(0, 6);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, dest);
}

function slug(text, fallback = 'candidate') {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fileNameSafe(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function runScript(script, args, cwd = REPO_ROOT) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolveBody(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function isInside(parent, child) {
  const rel = child.startsWith(parent);
  return rel;
}

function servePdf(res, filePath) {
  if (!existsSync(filePath)) return sendJson(res, 404, { error: 'not found' });
  const stat = statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename="${basename(filePath)}"`,
  });
  const stream = res;
  stream.end(readFileSync(filePath));
}

// --- YAML field upsert (comment-preserving) ------------------------------

const CANDIDATE_FIELDS = new Map([
  ['full_name', ['candidate', 'full_name']],
  ['email', ['candidate', 'email']],
  ['phone', ['candidate', 'phone']],
  ['location', ['candidate', 'location']],
  ['linkedin', ['candidate', 'linkedin']],
  ['github', ['candidate', 'github']],
  ['portfolio_url', ['candidate', 'portfolio_url']],
  ['photo', ['candidate', 'photo']],
]);

const EXTRA_FIELDS = new Map([
  ['roles', ['target_roles', 'primary']],
]);

const ALL_FIELD_PATHS = new Map([...CANDIDATE_FIELDS, ...EXTRA_FIELDS]);

function encodeScalar(value) {
  if (value === true || value === false || value === null) return String(value);
  if (typeof value === 'number') return Number.isNaN(value) ? 'null' : String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(String(value));
}

function upsertYamlField(yamlText, path, value) {
  const lines = yamlText.split(/\r?\n/);
  const [parentKey, key] = path;
  const encoded = encodeScalar(value);
  const parentRe = new RegExp(`^${parentKey}:\\s*$`);
  const childRe = new RegExp(`^(\\s+)${key}:\\s*(.*)$`);
  const parentIdx = lines.findIndex((l) => parentRe.test(l));
  const indent = '  ';

  if (parentIdx !== -1) {
    // Find the child line inside the parent block (deeper-indented lines after parentIdx).
    for (let i = parentIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(childRe);
      if (m) {
        const lead = m[1];
        const commentMatch = lines[i].match(/^(.*?)((?:\s+)#.*)?$/);
        const trailing = commentMatch ? commentMatch[2] || '' : '';
        lines[i] = `${lead}${key}: ${encoded}${trailing}`;
        return lines.join('\n');
      }
      if (/^\S/.test(lines[i]) && lines[i].trim()) break; // next top-level key
    }
    // Child not found — append after the parent block's last deeper line.
    let insertAt = parentIdx + 1;
    while (insertAt < lines.length && (/^\s/.test(lines[insertAt]) || !lines[insertAt].trim())) insertAt++;
    lines.splice(insertAt, 0, `${indent}${key}: ${encoded}`);
    return lines.join('\n');
  }

  // Parent block missing → append a new one at the end.
  const block = yamlText.endsWith('\n') ? '' : '\n';
  return yamlText + `${block}${parentKey}:\n${indent}${key}: ${encoded}\n`;
}

// --- CV tailoring pipeline ------------------------------------------------

function buildCandidateSlug(profile, parsed) {
  return slug((parsed && parsed.name) || (profile && profile.candidate && profile.candidate.full_name) || 'candidate');
}

function generateForJob(job) {
  const cvPath = join(DATA_ROOT, 'cv.md');
  if (!existsSync(cvPath)) {
    return { error: 'Add your CV first — the Tailor CV tab needs cv.md to tailor from.' };
  }
  const profilePath = join(DATA_ROOT, 'config', 'profile.yml');
  let profile = null;
  if (existsSync(profilePath)) {
    try {
      profile = yamlLib ? yamlLib.load(readFileSync(profilePath, 'utf8')) : null;
    } catch {
      profile = null;
    }
  }

  const cvMd = readFileSync(cvPath, 'utf8');
  const parsed = parseCv(cvMd);
  const { payload, report } = tailor({ cvMd, profile, job });

  mkdirSync(GUI_SCRATCH, { recursive: true });
  const stamp = Date.now();
  const payloadFile = join(GUI_SCRATCH, `payload-${job.id}-${stamp}.json`);
  const htmlFile = join(OUTPUT_DIR, '_gui', `cv-${job.id}-${stamp}.html`);
  const candidateName = buildCandidateSlug(profile, parsed);
  const pdfFile = join(OUTPUT_DIR, `cv-${candidateName}-${slug(job.company)}-${slug(job.role)}-${today()}.pdf`);

  writeFileSync(payloadFile, JSON.stringify(payload, null, 2), 'utf8');

  const build = runScript('build-cv-html.mjs', [payloadFile, htmlFile]);
  if (build.code !== 0) {
    return { error: `build-cv-html.mjs failed:\n${(build.stderr || build.stdout).slice(-2000)}` };
  }

  const format = payload.page_format === 'a4' ? 'a4' : 'letter';
  const render = runScript('generate-pdf.mjs', [htmlFile, pdfFile, `--format=${format}`, '--allow-reorder']);
  if (render.code !== 0) {
    // Keep the HTML so the user can still view the tailored CV even when the
    // PDF render fails (e.g. no Chromium installed yet).
    return {
      warning: `PDF render failed (HTML retained):\n${(render.stderr || render.stdout).slice(-2000)}`,
      htmlFile,
      report,
      payload,
      pdf: null,
    };
  }

  return { pdfFile, htmlFile, report, payload, render };
}

// --- request routing -------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function handleApi(method, pathname, req, res) {
  const parts = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);

  // /api/state
  if (method === 'GET' && parts[0] === 'state') {
    const cvPath = join(DATA_ROOT, 'cv.md');
    const profilePath = join(DATA_ROOT, 'config', 'profile.yml');
    let outputs = [];
    if (existsSync(OUTPUT_DIR)) {
      outputs = readdirSync(OUTPUT_DIR)
        .filter((f) => f.endsWith('.pdf'))
        .map((f) => {
          const st = statSync(join(OUTPUT_DIR, f));
          return { name: f, size: st.size, mtime: st.mtime.toISOString() };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime))
        .slice(0, 50);
    }
    return sendJson(res, 200, {
      dataRoot: DATA_ROOT,
      cv: { exists: existsSync(cvPath) },
      profile: { exists: existsSync(profilePath) },
      outputs,
      jobs: readJobs().map(({ id, company, role, url, createdAt, lastGeneratedAt }) => ({
        id, company, role, url, createdAt, lastGeneratedAt,
      })),
    });
  }

  // /api/cv
  if (parts[0] === 'cv' && parts.length === 1) {
    if (method === 'GET') {
      const cvPath = join(DATA_ROOT, 'cv.md');
      if (!existsSync(cvPath)) return sendJson(res, 200, { content: '', exists: false });
      return sendJson(res, 200, { content: readFileSync(cvPath, 'utf8'), exists: true });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.content !== 'string') return sendJson(res, 400, { error: 'content must be a string' });
      if (Buffer.byteLength(body.content, 'utf8') > MAX_CV_BYTES) {
        return sendJson(res, 413, { error: 'CV exceeds 200 KB — trim it and save again.' });
      }
      const cvPath = join(DATA_ROOT, 'cv.md');
      atomicWrite(cvPath, body.content);
      return sendJson(res, 200, { ok: true, path: cvPath, bytes: Buffer.byteLength(body.content, 'utf8') });
    }
  }

  // /api/profile
  if (parts[0] === 'profile' && parts.length === 1) {
    if (method === 'GET') {
      const profilePath = join(DATA_ROOT, 'config', 'profile.yml');
      if (!existsSync(profilePath)) return sendJson(res, 200, { yaml: '', exists: false, json: null });
      const yaml = readFileSync(profilePath, 'utf8');
      let json = null;
      let error = null;
      try {
        json = yamlLib ? yamlLib.load(yaml) : null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      return sendJson(res, 200, { yaml, exists: true, json, error });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.yaml !== 'string') return sendJson(res, 400, { error: 'yaml must be a string' });
      if (yamlLib) {
        try {
          const parsed = yamlLib.load(body.yaml);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return sendJson(res, 400, { error: 'YAML must parse to a mapping (an object).' });
          }
        } catch (e) {
          return sendJson(res, 400, { error: `YAML error: ${e instanceof Error ? e.message : e}` });
        }
      }
      const profilePath = join(DATA_ROOT, 'config', 'profile.yml');
      atomicWrite(profilePath, body.yaml);
      return sendJson(res, 200, { ok: true });
    }
  }

  // /api/profile/fields — comment-preserving form updates
  if (parts[0] === 'profile' && parts[1] === 'fields' && method === 'POST') {
    const body = await readJsonBody(req);
    const profilePath = join(DATA_ROOT, 'config', 'profile.yml');
    if (!existsSync(profilePath)) {
      return sendJson(res, 400, { error: 'No profile yet — save it once from the raw YAML tab first.' });
    }
    let yaml = readFileSync(profilePath, 'utf8');
    let changed = false;
    for (const [field, value] of Object.entries(body.fields || {})) {
      const path = ALL_FIELD_PATHS.get(field);
      if (!path) continue;
      const mapped = field === 'roles' && Array.isArray(value) ? value : value;
      const next = upsertYamlField(yaml, path, mapped);
      if (next !== yaml) changed = true;
      yaml = next;
    }
    if (!changed) return sendJson(res, 200, { ok: true, changed: false });
    if (yamlLib) {
      try {
        yamlLib.load(yaml);
      } catch (e) {
        return sendJson(res, 400, { error: `Updated YAML does not parse — aborting: ${e instanceof Error ? e.message : e}` });
      }
    }
    atomicWrite(profilePath, yaml);
    return sendJson(res, 200, { ok: true, changed: true });
  }

  // /api/jobs
  if (parts[0] === 'jobs' && parts.length === 1) {
    if (method === 'GET') {
      const jobs = readJobs();
      return sendJson(res, 200, {
        jobs: jobs.map(({ id, company, role, url, createdAt, updatedAt, lastGeneratedAt, pdf, keywords }) => ({
          id, company, role, url, createdAt, updatedAt, lastGeneratedAt, pdf,
          keywords: keywords || { matched: [], gaps: [] },
        })),
      });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const company = fileNameSafe(body.company || '').trim();
      const role = fileNameSafe(body.role || '').trim();
      const url = String(body.url || '').trim();
      const text = String(body.text || '').trim();
      if (!company || !role) return sendJson(res, 400, { error: 'company and role are required' });
      if (text.length < 80) return sendJson(res, 400, { error: 'JD text is too short — paste the full job description (80+ chars).' });
      const jobs = readJobs();
      const dup = jobs.find((j) => j.company.toLowerCase() === company.toLowerCase() && j.role.toLowerCase() === role.toLowerCase());
      if (dup) return sendJson(res, 409, { error: `Job already in your library (${dup.company} — ${dup.role}). Open it below instead.` });
      const job = {
        id: `${slug(company)}-${randomUUID().slice(0, 6)}`,
        company,
        role,
        url: url.length ? url : null,
        text,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastGeneratedAt: null,
        pdf: null,
        keywords: { matched: [], gaps: [] },
      };
      jobs.unshift(job);
      persistJobs(jobs);
      return sendJson(res, 200, { ok: true, job });
    }
  }

  // /api/jobs/:id
  if (parts[0] === 'jobs' && parts.length === 2 && /^[A-Za-z0-9-]+$/.test(parts[1])) {
    const id = parts[1];
    const job = findJob(id);
    if (!job) return sendJson(res, 404, { error: 'job not found' });

    if (method === 'DELETE') {
      const jobs = readJobs().filter((j) => j.id !== id);
      persistJobs(jobs);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET') {
      return sendJson(res, 200, { job });
    }

    if (method === 'POST' && pathname.endsWith('/generate')) {
      const result = generateForJob(job);
      if (result.error) return sendJson(res, 400, { error: result.error });

      const jobs = readJobs();
      const updated = jobs.find((j) => j.id === id);
      if (updated) {
        updated.pdf = result.pdfFile ? basename(result.pdfFile) : null;
        updated.lastGeneratedAt = new Date().toISOString();
        updated.keywords = result.report.keywords;
        updated.report = {
          matchedTotal: result.report.matchedTotal,
          gapTotal: result.report.gapTotal,
          bulletsReordered: result.report.bulletsReordered,
          competenciesUsed: result.report.competenciesUsed,
          warnings: result.report.warnings,
        };
        persistJobs(jobs);
      }
      return sendJson(res, 200, {
        ok: true,
        pdf: updated ? updated.pdf : null,
        pdfUrl: updated && updated.pdf ? `/api/jobs/${id}/pdf` : null,
        report: result.report,
        payloadSections: Object.keys(result.payload).length,
        warning: result.warning || null,
      });
    }
  }

  // /api/jobs/:id/pdf | /api/jobs/:id/html
  if (parts[0] === 'jobs' && parts.length === 3 && /^[A-Za-z0-9-]+$/.test(parts[1])) {
    const job = findJob(parts[1]);
    if (!job) return sendJson(res, 404, { error: 'job not found' });
    if (method === 'GET' && parts[2] === 'pdf') {
      if (!job.pdf) return sendJson(res, 404, { error: 'No PDF generated yet — run Tailor CV first.' });
      const filePath = join(OUTPUT_DIR, job.pdf);
      if (!isInside(OUTPUT_DIR, filePath) || !existsSync(filePath)) return sendJson(res, 404, { error: 'PDF missing' });
      return servePdf(res, filePath);
    }
  }

  // /api/outputs
  if (parts[0] === 'outputs' && parts.length === 1 && method === 'GET') {
    let outputs = [];
    if (existsSync(OUTPUT_DIR)) {
      outputs = readdirSync(OUTPUT_DIR)
        .filter((f) => f.endsWith('.pdf'))
        .map((f) => {
          const st = statSync(join(OUTPUT_DIR, f));
          return { name: f, size: st.size, mtime: st.mtime.toISOString() };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime));
    }
    return sendJson(res, 200, { outputs });
  }

  // /api/outputs/:file
  if (parts[0] === 'outputs' && parts.length === 2 && method === 'GET') {
    const name = basename(parts[1]);
    if (!/^cv-.+\.pdf$/i.test(name)) return sendJson(res, 404, { error: 'not found' });
    const filePath = join(OUTPUT_DIR, name);
    if (!isInside(OUTPUT_DIR, filePath) || !existsSync(filePath)) return sendJson(res, 404, { error: 'not found' });
    return servePdf(res, filePath);
  }

  return sendJson(res, 404, { error: 'not found' });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, 404, { error: 'not found' });
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
}

function portFromArgs(args, fallback) {
  const idx = args.indexOf('--port');
  if (idx !== -1 && args[idx + 1]) {
    const n = Number(args[idx + 1]);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return Number(fallback) || 8787;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req.method, pathname, req, res);
    } else if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      sendJson(res, 400, { error: msg });
    } catch {
      res.writeHead(500);
      res.end('server error');
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`career-ops GUI →  http://127.0.0.1:${PORT}`);
  console.log(`data root      →  ${DATA_ROOT}`);
  console.log('Quit with Ctrl-C. Everything stays on this machine.');
});