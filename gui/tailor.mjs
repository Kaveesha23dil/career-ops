#!/usr/bin/env node
/**
 * gui/tailor.mjs — deterministic CV tailorer for the career-ops GUI.
 *
 * Wraps the repo's "reformulate, never fabricate" rule in code. Given a cv.md
 * (the canonical CV), an optional config/profile.yml, and one job's JD text,
 * it produces a build-cv-html.mjs-compatible payload WITHOUT inventing a
 * single fact or reworded claim:
 *
 *   - keywords are extracted ONLY from the JD  (matched vs. gap partition)
 *   - experience bullets are REORDERED by JD relevance (verbatim)
 *   - projects and competency tags are REORDERED / selected (verbatim)
 *   - the Professional Summary stays the user's own words, unchanged
 *   - unmatched JD keywords are reported as "gaps" — never injected
 *
 * The engine never emits prose, so grammar and honesty are both preserved by
 * construction: it can only highlight and re-order evidence that already
 * exists in the source files.
 *
 * Usage:
 *   node gui/tailor.mjs --self-test                 lint the parser/tailor
 *   node gui/tailor.mjs <cv.md> <jd.txt> [profile.yml]   # JSON report + payload
 *
 * API (imported by gui/server.mjs):
 *   import { tailor } from './tailor.mjs';
 *   const { payload, report } = tailor({ cvMd, profile, job });
 */

import { readFileSync } from 'node:fs';
import { isMainModule } from '../lib/is-main-module.mjs';

const SECTION_ALIASES = {
  professionalsummary: 'summary',
  summary: 'summary',
  profile: 'summary',
  workexperience: 'experience',
  experience: 'experience',
  employmenthistory: 'experience',
  professionalexperience: 'experience',
  careerhistory: 'experience',
  projects: 'projects',
  selectedprojects: 'projects',
  opensource: 'projects',
  projectexperience: 'projects',
  education: 'education',
  academicbackground: 'education',
  educationandtraining: 'education',
  certifications: 'certifications',
  certificates: 'certifications',
  licensescertifications: 'certifications',
  awards: 'awards',
  awardsandhonors: 'awards',
  honors: 'awards',
  interests: 'interests',
  corecompetencies: 'competencies',
  competencies: 'competencies',
  technicalskills: 'skills',
  skills: 'skills',
  skillsandtools: 'skills',
};

const STOP_WORDS = new Set(`
  a about above after again against all also am an and any are aren as at be because been
  before being below between both but by can cannot could did do does doing down during each
  few for from further had hadnt has have having he her here hers herself him himself his how
  i if in into is it its itself just me more most my myself no nor not now of off on once only
  or other our ours ourselves out over own same she should so some such than that the their
  theirs them themselves then there these they this those through to too under until up very
  was we were what when where which while who whom why will with would you your yours yourself
  yourselves job role position company team work working experience required responsibilities
  qualifications skills knowledge ability duties include including strong candidate will must
  etc plus keep years month weeks day days position opportunity ideal corporate based remote
  onsite hybrid fulltime full parttime apply posting offer salary benefits we proud culture
  mission values growth join looking new great good best excellent highly relevant minimum
  preferred nice certified equival ent equivalent desired maintain develop manage build design
  implement support lead leads owned drive driven focus focused collaborate cross collaborate
  contribute exposure familiarity exposure developeng develop engineerings
`.trim().split(/\s+/));

const BULLET_RE = /^\s*[-*+]\s+(.+)$/;
const ROLE_RE = /^\*\*(.+?)\*\*\s*$/;
const CONTACT_RE = /^\*\*(Location|Email|Phone|LinkedIn|Portfolio|GitHub):\*\*\s*(.+)$/i;
const CATEGORY_RE = /^\*\*([^*]+):\*\*\s*(.+)$/;

function normKey(title) {
  return (title || '').toLowerCase().replace(/[^a-z0-9]+/gi, '');
}

function clean(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function isDateLine(line) {
  return /^[A-Za-z]{3,9}\s+\d{4}\s*[-–—]|^(?:19|20)\d{2}\s*[-–—](?:\s*(?:present|current|now|(?:19|20)\d{2}))?|^(?:19|20)\d{2}\s*(?:-|–|—|to)\s*[A-Za-z0-9]+$/i.test(
    line,
  );
}

function parseCompanyHeader(header, cur) {
  const s = clean(header);
  const dash = s.split(/\s*--\s*|-{2,}/);
  if (dash.length >= 2) {
    cur.company = clean(dash[0]);
    cur.location = clean(dash.slice(1).join(' -- '));
    return;
  }
  const paren = s.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (paren && clean(paren[2])) {
    cur.company = clean(paren[1]);
    cur.location = clean(paren[2]);
    return;
  }
  cur.company = s;
}

function parseExperience(lines) {
  const entries = [];
  let cur = null;
  for (const raw of lines) {
    const line = clean(raw);
    if (!line) continue;
    const h = line.match(/^###\s+(.{1,200})$/);
    if (h) {
      cur = { company: '', role: '', location: '', dates: '', bullets: [] };
      parseCompanyHeader(h[1], cur);
      entries.push(cur);
      continue;
    }
    if (!cur) {
      cur = { company: '', role: '', location: '', dates: '', bullets: [] };
      entries.push(cur);
    }
    const b = line.match(BULLET_RE);
    if (b) {
      cur.bullets.push(clean(b[1]));
      continue;
    }
    const r = line.match(ROLE_RE);
    if (r && !cur.role) {
      cur.role = clean(r[1]);
      continue;
    }
    if (isDateLine(line) && !cur.dates) {
      cur.dates = line;
      continue;
    }
    const loc = line.match(/^Location\s*[:：]\s*(.+)$/i);
    if (loc) {
      cur.location = clean(loc[1]);
      continue;
    }
    if (!cur.role && line.length <= 120) {
      cur.role = line;
      continue;
    }
    cur.bullets.push(line);
  }
  return entries.filter(e => e.company || e.role || e.bullets.length > 0);
}

function parseProjects(lines) {
  const out = [];
  for (const raw of lines) {
    const line = clean(raw);
    if (!line) continue;
    const b = line.match(BULLET_RE);
    const text = clean(b ? b[1] : line);
    if (!text) continue;
    const nameMatch = text.match(/^\*\*(.+?)\*\*\s*(?:\(([^)]*)\))?\s*(?:--\s*)?(.*)$/);
    if (nameMatch) {
      out.push({
        name: clean(nameMatch[1]),
        badge: clean(nameMatch[2]),
        description: clean(nameMatch[3]),
        tech: '',
      });
      continue;
    }
    const parts = text.split(/\s*--\s*/);
    const name = clean(parts[0]);
    if (!name) continue;
    const descM = text.match(/\((.*?)\)\s*(?:--\s*(.*))?$/);
    out.push({
      name,
      badge: descM ? clean(descM[1]) : '',
      description: clean(parts.slice(1).join(' -- ')),
      tech: '',
    });
  }
  return out;
}

function lastYear(text) {
  const m = clean(text).match(/\(?(\b(?:19|20)\d{2})\b\)?/);
  return m ? m[1] : '';
}

function parseEducation(lines) {
  const out = [];
  for (const raw of lines) {
    const line = clean(raw);
    if (!line) continue;
    const b = line.match(BULLET_RE);
    const text = clean(b ? b[1] : line);
    if (!text) continue;
    const year = lastYear(text);
    const parts = text.replace(/\(?(\b(?:19|20)\d{2})\b\)?/g, '').split(/\s*[,;]\s+/).map(clean).filter(Boolean);
    out.push({
      title: parts[0] || text,
      org: parts[1] || '',
      year,
      description: parts.slice(2).join(', '),
    });
  }
  return out;
}

function parseFields(lines) {
  const out = [];
  for (const raw of lines) {
    const line = clean(raw);
    if (!line) continue;
    const b = line.match(BULLET_RE);
    const text = clean(b ? b[1] : line);
    if (!text) continue;
    const year = lastYear(text);
    const org = text.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    out.push({
      title: clean(org ? org[1] : text.replace(/\s*\(?\b(?:19|20)\d{2}\b\)?$/, '')),
      org: org ? clean(org[2]) : '',
      year,
    });
  }
  return out;
}

function parseCompetencies(lines) {
  const tags = [];
  for (const raw of lines) {
    const line = clean(raw);
    if (!line) continue;
    const b = line.match(BULLET_RE);
    const text = clean(b ? b[1] : line);
    if (!text) continue;
    for (const part of text.split(/[;|]/)) {
      for (const t of part.split(',')) {
        const tag = clean(t);
        if (tag) tags.push(tag);
      }
    }
  }
  return tags;
}

function parseSkills(lines) {
  const cats = [];
  for (const raw of lines) {
    const line = clean(raw);
    if (!line) continue;
    const b = line.match(BULLET_RE);
    const text = clean(b ? b[1] : line);
    if (!text) continue;
    const m = text.match(CATEGORY_RE);
    if (m) {
      const items = m[2].split(/[,;]/).map(clean).filter(Boolean);
      if (items.length) cats.push({ category: clean(m[1]), items });
    } else {
      const items = text.split(/[,;]/).map(clean).filter(Boolean);
      if (items.length) cats.push({ category: '', items });
    }
  }
  return cats;
}

function parseInterests(lines) {
  const out = [];
  for (const raw of lines) {
    const line = clean(raw);
    if (!line) continue;
    const b = line.match(BULLET_RE);
    const text = clean(b ? b[1] : line);
    if (!text) continue;
    for (const part of text.split(/[,;]/)) {
      const item = clean(part);
      if (item) out.push(item);
    }
  }
  return out;
}

export function parseCv(md) {
  const result = {
    name: '',
    contacts: {},
    sections: {},
    order: [],
    warnings: [],
  };
  let current = 'header';
  const blocks = {};

  for (const rawLine of String(md || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#\s+/.test(line)) {
      if (!result.name) {
        result.name = clean(line.replace(/^#\s+/, '').replace(/^CV\s*--\s*/i, '').replace(/^CURRICULUM\s+VITAE\s*--?\s*/i, ''));
      }
      continue;
    }
    if (/^##\s+/.test(line)) {
      const title = clean(line.replace(/^##\s+/, ''));
      const mapped = SECTION_ALIASES[normKey(title)];
      current = mapped || title.toLowerCase();
      const key = normKey(current);
      if (!(key in blocks)) {
        blocks[key] = [];
        result.order.push({ key, title, mapped });
      }
      continue;
    }
    if (/^###\s+/.test(line) && current === 'header') continue;
    if (current === 'header') {
      const m = line.match(CONTACT_RE);
      if (m && clean(m[2])) result.contacts[m[1].toLowerCase()] = clean(m[2]);
      continue;
    }
    const key = normKey(current);
    if (key in blocks) blocks[key].push(line);
  }

  const s = (key) => blocks[normKey(key)] || [];
  const seen = (name) => result.order.some(o => o.mapped === name);

  if (seen('summary')) result.sections.summary = clean(s('summary').join(' ').replace(BULLET_RE, '$1'));
  if (seen('experience')) {
    const parsed = parseExperience(s('experience'));
    if (parsed.length === 0) result.warnings.push('Work Experience found but no roles were parsed — check the "### Company -- Location" format.');
    result.sections.experience = parsed;
  }
  if (seen('projects')) result.sections.projects = parseProjects(s('projects'));
  if (seen('education')) result.sections.education = parseEducation(s('education'));
  if (seen('certifications')) result.sections.certifications = parseFields(s('certifications'));
  if (seen('awards')) result.sections.awards = parseFields(s('awards'));
  if (seen('interests')) result.sections.interests = parseInterests(s('interests'));
  if (seen('competencies')) result.sections.competencies = parseCompetencies(s('competencies'));
  if (seen('skills')) result.sections.skills = parseSkills(s('skills'));

  return result;
}

export function extractKeywords(text, max = 30) {
  const words = String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [];
  const counts = new Map();
  for (const w of words) {
    if (STOP_WORDS.has(w) || w.length < 3) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([word, count]) => ({ word, count }));
}

export function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [];
}

function scoreText(tokens, keywords) {
  let score = 0;
  const hit = new Set();
  for (const { word } of keywords) {
    for (const t of tokens) {
      if (t === word) {
        hit.add(word);
        score += 1;
        break;
      }
    }
  }
  return score;
}

// Keyword overlap scored as a simple weighted count; keywords from the JD are
// the ONLY lens, so reordering can never promote a claim the JD doesn't reward.
function scoresFor(entries, keywords) {
  const scores = new Map();
  let total = 0;
  for (const e of entries) {
    const text = JSON.stringify([e]).replace(/[^a-z0-9+# -]/gi, ' ');
    const tokens = tokenize(text);
    const score = scoreText(tokens, keywords);
    scores.set(e, score);
    total += score;
  }
  return { scores, total };
}

function stableReorder(entries, scoreMap) {
  return entries
    .map((e, i) => ({ e, i, s: scoreMap.get(e) || 0 }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.e);
}

function reorderBullets(entry, keywordFreq) {
  const scored = entry.bullets.map(bullet => ({
    bullet,
    s: scoreText(tokenize(bullet), keywordFreq),
  }));
  let moved = 0;
  const sorted = [...scored].sort((a, b) => b.s - a.s || scored.indexOf(a) - scored.indexOf(b));
  sorted.forEach((x, idx) => {
    if (scored[idx] !== x) moved += 1;
  });
  return { bullets: sorted.map(x => x.bullet), moved };
}

function matchedVsGaps(keywords, cvTexts) {
  const hay = new Set(cvTexts.flatMap(t => tokenize(t)));
  const matched = [];
  const gaps = [];
  for (const k of keywords) {
    if (hay.has(k.word)) matched.push(k);
    else gaps.push(k);
  }
  return { matched, gaps };
}

function asHref(value) {
  const url = clean(value);
  if (!url) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (url.includes('@')) return 'mailto:' + url;
  return 'https://' + url.replace(/^\/\//, '');
}

function displayOf(url) {
  return clean(url).replace(/^https?:\/\//i, '').replace(/^\/\//, '').replace(/\/$/, '');
}

function linkField(value) {
  const url = asHref(value);
  return url ? { url, display: displayOf(url) } : null;
}

function buildCandidate(parsed, profile) {
  const p = (profile && profile.candidate) || {};
  const c = parsed.contacts;
  const candidate = {
    name: parsed.name || p.full_name || '',
    phone: c.phone || p.phone || '',
    email: c.email || p.email || '',
    location: c.location || p.location || '',
  };
  const linkedin = linkField(c.linkedin || p.linkedin);
  if (linkedin) candidate.linkedin = linkedin;
  const github = linkField(c.github || p.github);
  if (github) candidate.github = github;
  const portfolio = linkField(c.portfolio || p.portfolio_url);
  if (portfolio) candidate.portfolio = portfolio;
  if (p.photo) {
    candidate.photo = p.photo;
    candidate.photo_style = p.photo_style || 'rounded';
  }
  return candidate;
}

/**
 * tailor — the public entrypoint.
 * @param {{cvMd?: string, profile?: object|null, job: {company:string, role:string, url?:string, text:string}}} input
 * @returns {{payload: object, report: object}}
 */
export function tailor({ cvMd, profile = null, job }) {
  if (!job || !job.text) {
    throw new Error('job.text (the JD) is required');
  }
  const parsed = parseCv(cvMd || '');
  const keywords = extractKeywords(job.text, 30);

  const sections = parsed.sections;
  const cvTexts = [
    sections.summary || '',
    ...(sections.competencies || []),
    ...(sections.skills || []).flatMap(s => ([s.category, ...(s.items || [])])),
    ...(sections.experience || []).flatMap(e => [e.company, e.role, ...(e.bullets || [])]),
    ...(sections.projects || []).flatMap(p => [p.name, p.description, p.tech]),
    ...(sections.education || []).flatMap(e => [e.title, e.org]),
  ].filter(Boolean);

  const { matched, gaps } = matchedVsGaps(keywords, cvTexts);

  let bulletsReordered = 0;
  const experience = (sections.experience || []).map((entry) => {
    const { bullets, moved } = reorderBullets(entry, matched);
    bulletsReordered += moved;
    return { ...entry, bullets };
  });

  const skills = (sections.skills || []).map((cat) => {
    const items = stableReorder([...(cat.items || [])], new Map(
      [...(cat.items || [])].map(it => [it, scoreText(tokenize(it), matched)]),
    ));
    return { category: cat.category || '', items };
  });

  const projects = sections.projects
    ? stableReorder(sections.projects, scoresFor(sections.projects, matched).scores)
    : undefined;

  const competenciesAll = sections.competencies || (sections.skills ? mergedCompetencyPool(sections.skills) : []);
  const competencies = stableReorder(competenciesAll, scoresFor(competenciesAll, matched).scores).slice(0, 8);

  const payload = {
    lang: (profile && profile.language && profile.language.output) || 'en',
    page_format: pageFormatOf(profile),
    candidate: buildCandidate(parsed, profile),
    summary: sections.summary || '',
    competencies,
    experience: experience.length ? experience : undefined,
    projects: projects && projects.length ? projects : undefined,
    education: (sections.education || []).length ? sections.education : undefined,
    certifications: (sections.certifications || []).length ? sections.certifications : undefined,
    awards: (sections.awards || []).length ? sections.awards : undefined,
    interests: (sections.interests || []).length ? sections.interests : undefined,
    skills: skills.length ? skills : undefined,
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }

  return {
    payload,
    report: {
      keywords: { matched, gaps },
      matchedTotal: matched.length,
      gapTotal: gaps.length,
      bulletsReordered,
      competenciesUsed: competencies.length,
      warnings: parsed.warnings,
    },
  };
}

function mergedCompetencyPool(skills) {
  const pool = [];
  for (const cat of skills) {
    const it = Array.isArray(cat.items) ? cat.items : [];
    if (cat.category && it.length) pool.push(cat.category);
    pool.push(...it);
  }
  return [...new Set(pool)].slice(0, 40);
}

function pageFormatOf(profile) {
  const cv = (profile && profile.cv) || {};
  const raw = cv.page_format || profile.page_format || 'letter';
  return String(raw).toLowerCase() === 'a4' ? 'a4' : 'letter';
}

// --- CLI helpers (self-test + manual QA) -------------------------------

function sampleCv() {
  return `# CV -- Jane Smith

**Location:** San Francisco, CA
**Email:** jane@example.com
**LinkedIn:** linkedin.com/in/janesmith
**Portfolio:** https://janesmith.dev
**GitHub:** github.com/janesmith

## Professional Summary
ML engineer with 8 years building end-to-end machine learning pipelines and a proven record shipping retrieval-augmented products to production.

## Work Experience
### Acme Analytics -- Remote

**Senior ML Engineer**
2021 - Present

- Cut retrieval latency 40% with a hybrid dense/sparse index
- Led a team of 5 building LLM summarization services
- Reduced pipeline cost 30% by caching embeddings

### Startup Co -- Berlin, Germany

**ML Engineer**
2018 - 2021

- Built real-time fraud detection with **Python** and PyTorch
- Shipped ETL pipelines in Spark that process 2B events/day
- Improved model precision from 0.82 to 0.91

## Projects
- **Open Source RAG Toolkit** (Python) -- LLM retrieval library with 2K stars
- Personal Chat Assistant -- fine-tuned a 7B model on domain docs

## Education
- M.Sc. Computer Science, TU Berlin (2018)
- B.Sc. Statistics, LMU Munich (2015)

## Skills
- **Languages:** Python, TypeScript, SQL
- **ML/LLM:** PyTorch, LangChain, FastAPI
- **Infra:** Docker, Kubernetes, AWS, Airflow
`;
}

function sampleJob() {
  return `We are looking for a Senior Machine Learning Engineer to join our applied AI team. You will design and own retrieval-augmented generation (RAG) systems, optimize embedding pipelines, and ship LLM-powered products to production. Strong Python and PyTorch required, experience with Kubernetes preferred.`;
}

export function runSelfTest() {
  const { payload, report } = tailor({ cvMd: sampleCv(), profile: { candidate: { full_name: null } }, job: { company: 'Test', role: 'Test', text: sampleJob() } });
  const checks = [
    ['keywords extracted', report.keywords.matched.length + report.keywords.gaps.length > 0],
    ['matched partition works', Array.isArray(report.keywords.matched)],
    ['gap partition works', Array.isArray(report.keywords.gaps)],
    ['experience parsed', Array.isArray(payload.experience) && payload.experience.length === 2],
    ['bullets reordered', typeof report.bulletsReordered === 'number'],
    ['summary untouched', payload.summary.startsWith('ML engineer with 8 years')],
    ['candidate named', payload.candidate.name === 'Jane Smith'],
    ['contact row built', payload.candidate.email === 'jane@example.com'],
    ['skills parsed', Array.isArray(payload.skills) && payload.skills.length === 3],
    ['education mapped to html keys', payload.education && payload.education[0].title && payload.education[0].org],
    ['payload validates schema keys for html', !payload.experience.some(e => !e.company || !e.role)],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${checks.length} self-tests passed.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const [cvPath, jdPath, profilePath] = args;
  if (!cvPath || !jdPath) {
    console.error('Usage: node gui/tailor.mjs <cv.md> <jd.txt> [profile.yml] | --self-test');
    process.exit(1);
  }
  const cvMd = readFileSync(cvPath, 'utf8');
  const jobText = readFileSync(jdPath, 'utf8');
  let profile = null;
  try {
    if (profilePath) {
      const yaml = await import('js-yaml');
      profile = yaml.load(readFileSync(profilePath, 'utf8'));
    }
  } catch {
    /* js-yaml absent: profile stays null */
  }
  const { payload, report } = tailor({ cvMd, profile, job: { company: '', role: '', text: jobText } });
  process.stdout.write(JSON.stringify({ report, payload }, null, 2));
}

// Run the CLI tail only when executed directly (imported by gui/server.mjs).
if (isMainModule(import.meta.url)) {
  main();
}