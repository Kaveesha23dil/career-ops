/* career-ops GUI — single-page client, no frameworks, offline. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  jobs: [],
  selectedId: null,
  profileYamlDirty: false,
};

// ---------- helpers ----------

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtBytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function fmtDate(iso) {
  if (!iso) return 'not generated yet';
  return new Date(iso).toLocaleString();
}

function setStatus(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

// ---------- tabs ----------

function bindTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    $$('.tab').forEach((t) => t.classList.toggle('active', t === btn));
    $$('.pane').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === 'outputs') refreshOutputs();
  });
}

// ---------- CV ----------

function starterTemplate() {
  const v = (id) => ($(id) ? $(id).value.trim() : '');
  const name = v('#pf-full_name') || 'Your Name';
  const lines = [
    `# CV -- ${name}`,
    '',
    `**Location:** ${v('#pf-location') || 'City, Country'}`,
    `**Email:** ${v('#pf-email') || 'you@example.com'}`,
    `**LinkedIn:** ${v('#pf-linkedin') || 'linkedin.com/in/you'}`,
    `**Portfolio:** ${v('#pf-portfolio_url') || ''}`,
    `**GitHub:** ${v('#pf-github') || ''}`,
    '',
    '## Professional Summary',
    '',
    '2-4 line summary of who you are and the value you deliver. Every number here must be true from your real work.',
    '',
    '## Work Experience',
    '',
    '### Company Name -- Location',
    '',
    '**Job Title**',
    '2022 - Present',
    '',
    '- Achievement bullet with a quantified result',
    '- Another achievement, measurable where possible',
    '',
    '### Previous Company -- Location',
    '',
    '**Job Title**',
    '2018 - 2022',
    '',
    '- What you built and what it achieved',
    '',
    '## Projects',
    '',
    '- **Project Name** (type) -- what it is + hero metric',
    '',
    '## Education',
    '',
    '- Degree, Institution (Year)',
    '',
    '## Skills',
    '',
    '- **Languages:** ...',
    '- **Frameworks:** ...',
    '',
  ];
  return lines.filter((l) => l.trim() !== '' || l === '').join('\n');
}

function bindCv() {
  $('#cvSave').addEventListener('click', async () => {
    const content = $('#cvText').value;
    if (!content.trim()) {
      setStatus('#cvStatus', 'Nothing to save — your CV is empty.', 'err');
      return;
    }
    const btn = $('#cvSave');
    btn.disabled = true;
    try {
      const res = await api('/cv', { method: 'POST', body: { content } });
      setStatus('#cvStatus', `Saved ${fmtBytes(res.bytes)} → ${res.path.split(sepGuess()).pop()} (backup: cv.md.bak)`, 'ok');
      $('#cvEmpty').classList.add('hidden');
    } catch (e) {
      setStatus('#cvStatus', e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('#cvSeed').addEventListener('click', () => {
    if ($('#cvText').value.trim() && !confirm('Replace the current CV text with a starter template?')) return;
    $('#cvText').value = starterTemplate();
    $('#cvEmpty').classList.add('hidden');
    setStatus('#cvStatus', 'Template inserted — fill it in, then Save CV.', 'ok');
  });
}

function sepGuess() { return navigator.userAgent.includes('Windows') ? '\\' : '/'; }

// ---------- Profile ----------

function fillProfileForm(json) {
  if (!json) return;
  const c = json.candidate || {};
  const set = (id, val) => { const el = $(id); if (el && val != null) el.value = val; };
  set('#pf-full_name', c.full_name || '');
  set('#pf-email', c.email || '');
  set('#pf-phone', c.phone || '');
  set('#pf-location', c.location || '');
  set('#pf-linkedin', c.linkedin || '');
  set('#pf-github', c.github || '');
  set('#pf-portfolio_url', c.portfolio_url || '');
  set('#pf-photo', c.photo || '');
  const primary = Array.isArray((json.target_roles || {}).primary)
    ? json.target_roles.primary
    : typeof (json.target_roles || {}).primary === 'string'
      ? [json.target_roles.primary]
      : [];
  set('#pf-roles', primary.join('\n'));
  $('#profileEmpty').classList.toggle('hidden', json.candidate !== undefined || json.target_roles !== undefined);
}

function bindProfile() {
  $('#profileSave').addEventListener('click', async () => {
    const btn = $('#profileSave');
    btn.disabled = true;
    try {
      if (state.profileYamlDirty) {
        const yaml = $('#profileYaml').value;
        if (!yaml.trim()) throw new Error('Raw YAML is empty — nothing to save.');
        await api('/profile', { method: 'POST', body: { yaml } });
        state.profileYamlDirty = false;
        setStatus('#profileStatus', 'Saved raw profile.yml (backup: profile.yml.bak)', 'ok');
        return;
      }
      const fields = {
        full_name: $('#pf-full_name').value.trim(),
        email: $('#pf-email').value.trim(),
        phone: $('#pf-phone').value.trim(),
        location: $('#pf-location').value.trim(),
        linkedin: $('#pf-linkedin').value.trim(),
        github: $('#pf-github').value.trim(),
        portfolio_url: $('#pf-portfolio_url').value.trim(),
        photo: $('#pf-photo').value.trim(),
        roles: $('#pf-roles').value.split('\n').map((s) => s.trim()).filter(Boolean),
      };
      const res = await api('/profile/fields', { method: 'POST', body: { fields } });
      const msg = res.changed
        ? 'Profile updated in place — comments and custom keys preserved.'
        : 'No changes detected.';
      setStatus('#profileStatus', msg + ' (backup: profile.yml.bak)', 'ok');
    } catch (e) {
      setStatus('#profileStatus', e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('#profileYaml').addEventListener('input', () => { state.profileYamlDirty = true; });
}

// ---------- Jobs + tailor ----------

function renderJobs() {
  const ul = $('#jobList');
  ul.innerHTML = '';
  if (state.jobs.length === 0) {
    ul.innerHTML = '<li class="hint">No jobs yet — add one above.</li>';
    return;
  }
  for (const job of state.jobs) {
    const li = document.createElement('li');
    li.className = 'job-item' + (job.id === state.selectedId ? ' selected' : '');
    li.innerHTML = `
      <div class="j-company">${esc(job.company)}</div>
      <div class="j-role">${esc(job.role)}</div>
      <div class="j-foot">
        <span class="j-status">${job.pdf ? 'PDF ready' : (job.lastGeneratedAt ? 'tailored (no PDF)' : '')}</span>
        <span class="j-actions">
          <button class="btn" data-act="select">Open</button>
          <button class="btn" data-act="delete" title="Remove from library">Remove</button>
        </span>
      </div>`;
    li.querySelector('[data-act="select"]').addEventListener('click', () => selectJob(job.id));
    li.querySelector('[data-act="delete"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${job.company} — ${job.role}" from your library?`)) return;
      try {
        await api(`/jobs/${job.id}`, { method: 'DELETE' });
        await loadJobs();
        state.selectedId = state.jobs.length ? state.jobs[0].id : null;
        renderDetail();
      } catch (err) {
        alert(err.message);
      }
    });
    ul.appendChild(li);
  }
}

function chipsHtml(keywords, cls) {
  if (!keywords || !keywords.length) return '<span class="hint">none captured</span>';
  return keywords.map((k) => `<span class="chip">${esc(k.word)}</span>`).join('');
}

function renderDetail() {
  const job = state.jobs.find((j) => j.id === state.selectedId);
  const empty = $('#jobDetailEmpty');
  const detail = $('#jobDetail');
  if (!job) {
    empty.classList.remove('hidden');
    detail.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  detail.classList.remove('hidden');

  $('#jobDetailCompany').textContent = job.company;
  $('#jobDetailRole').textContent = job.role;
  const urlEl = $('#jobDetailUrl');
  if (job.url) {
    urlEl.href = job.url;
    urlEl.textContent = job.url;
    urlEl.classList.remove('hidden');
  } else {
    urlEl.classList.add('hidden');
  }
  $('#jobDetailMeta').textContent = `Added ${fmtDate(job.createdAt)} · last tailored ${fmtDate(job.lastGeneratedAt)}`;

  const report = job.report;
  const hasReport = Boolean(report);
  $('#jobReport').classList.toggle('hidden', !hasReport);
  if (hasReport) {
    $('#jobMatched').innerHTML = chipsHtml(job.keywords ? job.keywords.matched : []);
    $('#jobGaps').innerHTML = chipsHtml(job.keywords ? job.keywords.gaps : []);
    const items = [
      `${report.competenciesUsed} competency tags highlighted for this JD`,
      `${report.bulletsReordered} experience bullets reordered by JD relevance`,
      `${report.matchedTotal} JD keywords matched in your CV`,
      `${report.gapTotal} JD keywords not in your CV (listed above — never auto-injected)`,
    ];
    if (report.warnings && report.warnings.length) items.push(`⚠ ${report.warnings.join(' · ')}`);
    $('#jobStats').innerHTML = items.map((i) => `<li>${esc(i)}</li>`).join('');
  }

  const wrap = $('#jobPdfWrap');
  const frame = $('#jobPdfFrame');
  const link = $('#jobPdfLink');
  if (job.pdf) {
    const url = `/api/jobs/${job.id}/pdf`;
    link.href = url;
    link.setAttribute('download', job.pdf);
    frame.src = url + '?' + Date.now();
    wrap.classList.remove('hidden');
  } else {
    wrap.classList.add('hidden');
    frame.removeAttribute('src');
  }
  $('#jobWarnings').classList.add('hidden');
  $('#jobGenStatus').textContent = '';
  $('#jobGenStatus').className = 'status';
}

async function loadJobs() {
  const data = await api('/jobs');
  state.jobs = data.jobs;
  if (!state.jobs.some((j) => j.id === state.selectedId)) {
    state.selectedId = state.jobs[0] ? state.jobs[0].id : null;
  }
  renderJobs();
  renderDetail();
}

function selectJob(id) {
  state.selectedId = id;
  renderJobs();
  renderDetail();
}

function bindTailor() {
  $('#jobAdd').addEventListener('click', async () => {
    const text = $('#job-text').value.trim();
    const company = $('#job-company').value.trim();
    const role = $('#job-role').value.trim();
    const url = $('#job-url').value.trim();
    if (!company || !role) {
      setStatus('#jobAddStatus', 'Company and role are required.', 'err');
      return;
    }
    if (text.length < 80) {
      setStatus('#jobAddStatus', 'JD text too short — paste the full description.', 'err');
      return;
    }
    const btn = $('#jobAdd');
    btn.disabled = true;
    try {
      const res = await api('/jobs', { method: 'POST', body: { company, role, url, text } });
      $('#job-company').value = '';
      $('#job-role').value = '';
      $('#job-url').value = '';
      $('#job-text').value = '';
      setStatus('#jobAddStatus', `Added ${res.job.company} — ${res.job.role}`, 'ok');
      await loadJobs();
      state.selectedId = res.job.id;
      renderJobs();
      renderDetail();
    } catch (e) {
      setStatus('#jobAddStatus', e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('#jobTailor').addEventListener('click', async () => {
    const job = state.jobs.find((j) => j.id === state.selectedId);
    if (!job) return;
    const btn = $('#jobTailor');
    btn.disabled = true;
    const statusEl = $('#jobGenStatus');
    setStatus('#jobGenStatus', 'Tailoring your CV and rendering the PDF — this can take a minute (first run spins up Chromium)…', 'busy');
    try {
      const res = await api(`/jobs/${job.id}/generate`, { method: 'POST', body: {} });
      await loadJobs();
      if (res.warning) {
        $('#jobWarnings').textContent = res.warning;
        $('#jobWarnings').classList.remove('hidden');
      }
      setStatus('#jobGenStatus', res.pdf
        ? `Tailored CV ready — ${res.report.matchedTotal} JD keywords matched · ${res.report.bulletsReordered} bullets reordered.`
        : (res.warning ? 'Tailoring done, but the PDF render failed (see warning).' : 'Done.'), 'ok');
    } catch (e) {
      setStatus('#jobGenStatus', e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- Outputs ----------

function refreshOutputs() {
  const list = $('#outputsList');
  const render = (outputs) => {
    if (!outputs.length) {
      list.innerHTML = '<div class="empty"><p>No generated CVs yet. Tailor one in the <strong>Tailor CV</strong> tab.</p></div>';
      return;
    }
    const rows = outputs.map((o) => `
      <tr>
        <td><a href="/api/outputs/${encodeURIComponent(o.name)}" target="_blank" rel="noopener">${esc(o.name)}</a></td>
        <td>${fmtBytes(o.size)}</td>
        <td>${new Date(o.mtime).toLocaleString()}</td>
      </tr>`).join('');
    list.innerHTML = `<table class="outputs-table">
      <thead><tr><th>File</th><th>Size</th><th>Generated</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  };
  api('/outputs').then((d) => render(d.outputs)).catch(() => render([]));
}

// ---------- boot ----------

async function boot() {
  bindTabs();
  bindCv();
  bindProfile();
  bindTailor();

  try {
    const stateData = await api('/state');
    $('#dataRoot').textContent = 'data root: ' + stateData.dataRoot;

    const cv = await api('/cv');
    const cvTextEl = $('#cvText');
    cvTextEl.value = cv.content || '';
    $('#cvEmpty').classList.toggle('hidden', cv.exists || cv.content.trim() !== '');
    if (!cv.exists) cvTextEl.focus();
    if (cv.exists) {
      setStatus('#cvStatus', `Loaded cv.md (${cv.content.length} chars)`, 'ok');
    }

    const prof = await api('/profile');
    if (prof.exists) {
      $('#profileYaml').value = prof.yaml;
      if (prof.error) setStatus('#profileStatus', `Your profile.yml has a YAML error: ${prof.error}`, 'err');
      else fillProfileForm(prof.json);
    } else {
      $('#profileEmpty').classList.remove('hidden');
    }

    await loadJobs();
  } catch (e) {
    setStatus('#cvStatus', `Failed to load: ${e.message}`, 'err');
  }
}

boot();