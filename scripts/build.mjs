#!/usr/bin/env node
// Builds the profile stats cards and the open-source contributions table from public GitHub data.
// Runs daily in .github/workflows/profile.yml. Locally: GITHUB_TOKEN=... node scripts/build.mjs
// No dependencies. Only public data is used, so the output is the same with any token.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGIN = process.env.PROFILE_LOGIN || '0xArx';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error('GITHUB_TOKEN is required');

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// ---------- account + repos ----------
const base = await gql(`query($l:String!){user(login:$l){createdAt followers{totalCount}
  repositories(first:100, ownerAffiliations:OWNER, privacy:PUBLIC, isFork:false){totalCount nodes{name stargazerCount
    languages(first:10, orderBy:{field:SIZE,direction:DESC}){edges{size node{name color}}}}}}}`, { l: LOGIN });
const user = base.user;
const created = new Date(user.createdAt);
const now = new Date();

// ---------- contributions, every year since the account was made ----------
const years = [];
for (let y = created.getUTCFullYear(); y <= now.getUTCFullYear(); y++) years.push(y);
const yq = years.map(y => `y${y}:contributionsCollection(from:"${y}-01-01T00:00:00Z",to:"${y}-12-31T23:59:59Z"){
  contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}`).join('\n');
const contrib = (await gql(`query($l:String!){user(login:$l){${yq}}}`, { l: LOGIN })).user;
let allTime = 0; const days = [];
for (const y of years) {
  const cal = contrib[`y${y}`].contributionCalendar;
  allTime += cal.totalContributions;
  for (const w of cal.weeks) for (const d of w.contributionDays) days.push(d);
}
days.sort((a, b) => a.date.localeCompare(b.date));
const today = now.toISOString().slice(0, 10);
const past = days.filter(d => d.date <= today);
let longest = 0, run = 0;
for (const d of past) { run = d.contributionCount > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
let current = 0;
for (let i = past.length - 1; i >= 0; i--) {
  if (past[i].contributionCount > 0) current++;
  else if (i === past.length - 1) continue; // today not started yet
  else break;
}
const last365 = past.slice(-365).reduce((s, d) => s + d.contributionCount, 0);
const activeDays = past.filter(d => d.contributionCount > 0).length;

// ---------- languages (public repos, by code size) ----------
const langs = new Map();
for (const r of user.repositories.nodes) for (const e of r.languages.edges) {
  const cur = langs.get(e.node.name) || { size: 0, color: e.node.color || '#888' };
  cur.size += e.size; langs.set(e.node.name, cur);
}
const IGNORE = new Set(['HTML', 'CSS', 'Shell', 'Dockerfile', 'Makefile', 'Batchfile', 'PowerShell', 'Procfile', 'Jupyter Notebook']);
const langList = [...langs].filter(([n]) => !IGNORE.has(n)).sort((a, b) => b[1].size - a[1].size).slice(0, 6);
const langSum0 = langList.reduce((s, [, v]) => s + v.size, 0) || 1;
for (let i = langList.length - 1; i >= 0; i--) if (langList[i][1].size / langSum0 < 0.01) langList.splice(i, 1);
const langTotal = langList.reduce((s, [, v]) => s + v.size, 0) || 1;
const stars = user.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);

// ---------- open-source pull requests to other people's repos ----------
const prs = [];
let cursor = null;
do {
  const d = await gql(`query($q:String!,$c:String){search(query:$q,type:ISSUE,first:100,after:$c){pageInfo{hasNextPage endCursor}
    nodes{... on PullRequest{title url number state merged mergedAt createdAt
      repository{nameWithOwner stargazerCount isPrivate owner{login} primaryLanguage{name}}}}}}`,
    { q: `is:pr author:${LOGIN} -user:${LOGIN} sort:created-desc`, c: cursor });
  prs.push(...d.search.nodes.filter(n => n.repository && !n.repository.isPrivate));
  cursor = d.search.pageInfo.hasNextPage ? d.search.pageInfo.endCursor : null;
} while (cursor && prs.length < 300);
const MIN_STARS = 100; // only list real projects
const shown = prs.filter(p => p.repository.stargazerCount >= MIN_STARS && (p.merged || p.state === 'OPEN'));
const merged = prs.filter(p => p.merged && p.repository.stargazerCount >= MIN_STARS);
const ossPRs = prs.filter(p => p.repository.stargazerCount >= MIN_STARS && (p.merged || p.state === 'OPEN'));
const ossRepos = new Set(ossPRs.map(p => p.repository.nameWithOwner));

// ---------- write stats cards ----------
const fmt = n => n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US');
const yearsOn = Math.floor((now - created) / (365.25 * 864e5));
const since = created.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const tiles = [
  [fmt(allTime), 'contributions, all time'],
  [fmt(last365), 'in the last year'],
  [`${longest}`, `day best streak (now ${current})`],
  [fmt(activeDays), 'days with commits'],
  [`${ossPRs.length}`, `open-source PRs (${merged.length} merged)`],
  [`${ossRepos.size}`, 'AI projects contributed to'],
  [`${user.repositories.totalCount}`, 'public repos'],
  [fmt(stars), 'stars earned'],
];
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function card(theme) {
  const t = theme === 'dark'
    ? { bg1: '#0b0f17', bg2: '#111a2b', fg: '#e6edf3', mut: '#8b98a9', line: '#1f2a3c', tile: '#0f1624', acc: '#7c9cff', acc2: '#3ee6c1' }
    : { bg1: '#ffffff', bg2: '#f2f6fc', fg: '#0f1726', mut: '#5a6a80', line: '#dde5f1', tile: '#f7f9fc', acc: '#3457e0', acc2: '#0a9e7f' };
  const W = 1200, H = 420, pad = 48;
  const cols = 4, gap = 16, tw = (W - pad * 2 - gap * (cols - 1)) / cols, th = 92, ty0 = 120;
  let tilesSvg = '';
  tiles.forEach(([v, label], i) => {
    const x = pad + (i % cols) * (tw + gap), y = ty0 + Math.floor(i / cols) * (th + gap);
    tilesSvg += `<g>
<rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="12" fill="${t.tile}" stroke="${t.line}"/>
<text x="${x + 22}" y="${y + 48}" class="t" font-size="34" font-weight="700" fill="${t.fg}">${esc(v)}</text>
<text x="${x + 22}" y="${y + 74}" class="t" font-size="15" fill="${t.mut}">${esc(label)}</text></g>`;
  });
  // language bar
  const by = ty0 + 2 * (th + gap) + 22, bw = W - pad * 2;
  let bx = pad, bar = '', legend = '', lx = pad;
  langList.forEach(([name, v], i) => {
    const w = Math.max((v.size / langTotal) * bw, 4);
    bar += `<rect x="${bx}" y="${by}" width="${w}" height="10" fill="${v.color}"/>`;
    bx += w;
    const pct = `${Math.round((v.size / langTotal) * 100)}%`;
    legend += `<circle cx="${lx + 6}" cy="${by + 34}" r="6" fill="${v.color}"/><text x="${lx + 18}" y="${by + 39}" class="t" font-size="15" fill="${t.fg}">${esc(name)} <tspan fill="${t.mut}">${pct}</tspan></text>`;
    lx += 46 + (name.length + pct.length + 1) * 8.4;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${LOGIN} GitHub stats: ${allTime} contributions, ${yearsOn} years on GitHub`)}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/></linearGradient>
<linearGradient id="acc" x1="0" x2="1"><stop offset="0" stop-color="${t.acc}"/><stop offset="1" stop-color="${t.acc2}"/></linearGradient>
<clipPath id="barclip"><rect x="${pad}" y="${by}" width="${bw}" height="10" rx="5"/></clipPath>
<style>.t{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}.m{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.fade{opacity:0;animation:in .5s ease-out forwards}@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.fade{animation:none;opacity:1}}</style></defs>
<rect width="${W}" height="${H}" rx="18" fill="url(#bg)" stroke="${t.line}"/>
<text x="${pad}" y="70" class="t" font-size="30" font-weight="700" fill="${t.fg}">${yearsOn} years on GitHub</text>
<text x="${pad + 2}" y="98" class="t" font-size="16" fill="${t.mut}">Developer since ${since} · @${LOGIN}</text>
<rect x="${W - pad - 160}" y="52" width="160" height="30" rx="15" fill="none" stroke="url(#acc)"/>
<text x="${W - pad - 80}" y="72" text-anchor="middle" class="m" font-size="13" fill="${t.mut}">updated ${today}</text>
${tilesSvg}
<g clip-path="url(#barclip)">${bar}</g>
${legend}
</svg>`;
}
fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'assets/stats-dark.svg'), card('dark'));
fs.writeFileSync(path.join(ROOT, 'assets/stats-light.svg'), card('light'));

// ---------- contributions table in README ----------
let block = '';
if (shown.length) {
  const badge = (label, color) => `<img src="https://img.shields.io/badge/${encodeURIComponent(label).replace(/-/g, '--')}-${color}?style=flat-square" alt="${label}">`;
  const rows = shown.slice(0, 15).map(p => {
    const r = p.repository;
    const status = p.merged ? badge(`merged ${p.mergedAt.slice(0, 10)}`, '8957e5') : badge('in review', '2da44e');
    return `<tr><td><img src="https://github.com/${r.owner.login}.png?size=40" width="20" height="20" align="center" alt=""> <a href="https://github.com/${r.nameWithOwner}"><b>${esc(r.nameWithOwner)}</b></a><br><sub>★ ${fmt(r.stargazerCount)}${r.primaryLanguage ? ` · ${esc(r.primaryLanguage.name)}` : ''}</sub></td><td><a href="${p.url}">${esc(p.title)}</a> <sub>#${p.number}</sub></td><td>${status}</td></tr>`;
  });
  block = `## Open-source contributions\n\nFixes I've contributed to the AI and agent tools I use every day: ${ossPRs.length} pull request${ossPRs.length === 1 ? '' : 's'} across ${ossRepos.size} project${ossRepos.size === 1 ? '' : 's'}, ${merged.length} merged so far.\n\n<table>\n<tr><th align="left">Project</th><th align="left">Pull request</th><th align="left">Status</th></tr>\n${rows.join('\n')}\n</table>\n`;
  if (shown.length > 15) block += `\n<a href="https://github.com/pulls?q=is%3Apr+author%3A${LOGIN}+-user%3A${LOGIN}">See all ${shown.length} pull requests →</a>\n`;
}
const readmePath = path.join(ROOT, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const next = readme.replace(/<!-- OSS-CONTRIBUTIONS:START -->[\s\S]*?<!-- OSS-CONTRIBUTIONS:END -->/,
  `<!-- OSS-CONTRIBUTIONS:START -->\n${block}<!-- OSS-CONTRIBUTIONS:END -->`);
fs.writeFileSync(readmePath, next);
console.log(JSON.stringify({ yearsOn, since, allTime, last365, current, longest, activeDays, merged: merged.length, shown: shown.length, publicRepos: user.repositories.totalCount, stars, langs: langList.map(([n]) => n) }));
