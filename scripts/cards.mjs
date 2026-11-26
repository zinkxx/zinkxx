// Generates the profile's GitHub Analytics cards as static SVGs in ./assets.
// Runs daily from .github/workflows/profile-cards.yml with the workflow's GITHUB_TOKEN,
// so the README never depends on a third-party card service staying online.
// No dependencies: Node 20+ (global fetch).
import { mkdir, writeFile } from 'node:fs/promises';

const USER = process.env.GH_USER || 'zinkxx';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error('GITHUB_TOKEN is required');

const C = { bg: '#1a1b27', border: '#2a2e45', title: '#70a5fd', text: '#38bdae', muted: '#a9b1d6', icon: '#bf91f3', accent: '#f7768e' };
const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif";

const headers = { Authorization: `bearer ${TOKEN}`, 'User-Agent': 'profile-cards' };
async function gql(query, variables) {
  const r = await fetch('https://api.github.com/graphql', { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}
async function rest(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: { ...headers, Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => n.toLocaleString('en-US');
const short = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// ---------- data ----------
async function fetchData() {
  const base = await gql(`query($login:String!){ user(login:$login){ name createdAt
      followers{totalCount}
      contributionsCollection{ contributionYears } } }`, { login: USER });
  const u = base.user;

  // owned, public, non-fork repos: stars + languages
  const repos = [];
  let after = null;
  do {
    const d = await gql(`query($login:String!,$after:String){ user(login:$login){
        repositories(first:100, after:$after, ownerAffiliations:OWNER, isFork:false, privacy:PUBLIC){
          nodes{ name stargazerCount languages(first:10, orderBy:{field:SIZE, direction:DESC}){ edges{ size node{ name color } } } }
          pageInfo{ hasNextPage endCursor } } } }`, { login: USER, after });
    const page = d.user.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  // contribution calendar for every year
  const days = [];
  for (const year of u.contributionsCollection.contributionYears) {
    const d = await gql(`query($login:String!,$from:DateTime!,$to:DateTime!){ user(login:$login){
        contributionsCollection(from:$from, to:$to){ contributionCalendar{ weeks{ contributionDays{ date contributionCount } } } } } }`,
      { login: USER, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` });
    for (const w of d.user.contributionsCollection.contributionCalendar.weeks) days.push(...w.contributionDays);
  }
  const today = new Date().toISOString().slice(0, 10);
  const calendar = [...new Map(days.filter((x) => x.date <= today).map((x) => [x.date, x.contributionCount])).entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // search counts, limited to public repos so local runs and CI (GITHUB_TOKEN) agree
  const count = async (kind, q) => (await rest(`/search/${kind}?per_page=1&q=${encodeURIComponent(q)}`)).total_count;
  const commits = await count('commits', `author:${USER} is:public`);
  const prs = await count('issues', `author:${USER} type:pr is:public`);
  const issues = await count('issues', `author:${USER} type:issue is:public`);

  const langs = new Map();
  for (const r of repos) for (const e of r.languages.edges) {
    const cur = langs.get(e.node.name) || { size: 0, color: e.node.color || '#858585' };
    cur.size += e.size;
    langs.set(e.node.name, cur);
  }

  return {
    name: u.name || USER,
    stars: repos.reduce((s, r) => s + r.stargazerCount, 0),
    repos: repos.length,
    followers: u.followers.totalCount,
    prs,
    issues,
    commits,
    calendar,
    langs: [...langs.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.size - a.size),
  };
}

// ---------- cards ----------
const frame = (w, h, body, label) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<style>
  .t{font:600 18px ${FONT};fill:${C.title}}
  .l{font:600 14px ${FONT};fill:${C.text}}
  .v{font:700 14px ${FONT};fill:${C.muted}}
  .s{font:400 12px ${FONT};fill:${C.text}}
  .big{font:700 28px ${FONT};fill:${C.title}}
  .fade{opacity:0;animation:in .6s ease-out forwards}
  @keyframes in{to{opacity:1}}
</style>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${C.bg}" stroke="${C.border}"/>
${body}
</svg>
`;

const ICONS = {
  star: 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z',
  commit: 'M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z',
  pr: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z',
  issue: 'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z',
  repo: 'M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z',
  people: 'M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5.01 5.01 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.514 3.507 3.507 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4Zm-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5Z',
};

function statsCard(d) {
  const rows = [
    ['star', 'Total Stars Earned', d.stars],
    ['commit', 'Total Commits', d.commits],
    ['pr', 'Total PRs', d.prs],
    ['issue', 'Total Issues', d.issues],
    ['repo', 'Public Repos', d.repos],
    ['people', 'Followers', d.followers],
  ];
  const body = rows.map(([ic, label, val], i) => {
    const y = 62 + i * 25;
    return `<g class="fade" style="animation-delay:${150 + i * 120}ms" transform="translate(25 ${y})">
  <path transform="translate(0 -12)" fill="${C.icon}" d="${ICONS[ic]}"/>
  <text class="l" x="25" y="0">${label}:</text><text class="v" x="215" y="0">${fmt(val)}</text></g>`;
  }).join('\n');
  // ring: all-time contributions
  const total = d.calendar.reduce((s, [, c]) => s + c, 0);
  const ring = `<g transform="translate(375 112)">
  <circle r="46" fill="none" stroke="${C.title}" stroke-opacity=".2" stroke-width="6"/>
  <circle r="46" fill="none" stroke="${C.title}" stroke-width="6" stroke-linecap="round" stroke-dasharray="289" stroke-dashoffset="289" transform="rotate(-90)">
    <animate attributeName="stroke-dashoffset" from="289" to="0" dur="1.2s" fill="freeze"/></circle>
  <text class="big" text-anchor="middle" y="4" style="font-size:22px">${short(total)}</text>
  <text class="s" text-anchor="middle" y="21" style="font-size:10px">contributions</text></g>`;
  return frame(467, 215, `<text class="t" x="25" y="35">${esc(d.name)}'s GitHub Stats</text>\n${body}\n${ring}`, `${d.name}'s GitHub stats`);
}

function langsCard(d) {
  const top = d.langs.slice(0, 8);
  const sum = top.reduce((s, l) => s + l.size, 0) || 1;
  let x = 0;
  const bar = top.map((l) => {
    const w = (l.size / sum) * 250;
    const r = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="8" fill="${l.color}"/>`;
    x += w;
    return r;
  }).join('');
  const items = top.map((l, i) => {
    const cx = i % 2 === 0 ? 0 : 140;
    const cy = Math.floor(i / 2) * 22;
    return `<g class="fade" style="animation-delay:${200 + i * 90}ms" transform="translate(${cx} ${cy})"><circle cx="5" cy="6" r="5" fill="${l.color}"/><text class="s" x="15" y="10">${esc(l.name)} ${((l.size / sum) * 100).toFixed(2)}%</text></g>`;
  }).join('\n');
  return frame(300, 215, `<text class="t" x="25" y="35">Most Used Languages</text>
<clipPath id="bar"><rect x="0" y="0" width="250" height="8" rx="4"/></clipPath>
<g clip-path="url(#bar)" transform="translate(25 55)">${bar}</g>
<g transform="translate(25 80)">${items}</g>`, 'Most used languages');
}

function streakCard(d) {
  const cal = d.calendar;
  const total = cal.reduce((s, [, c]) => s + c, 0);
  // longest
  let best = { len: 0 }, run = null;
  for (const [date, c] of cal) {
    if (c > 0) { run = run ? { ...run, end: date, len: run.len + 1 } : { start: date, end: date, len: 1 }; if (run.len > best.len) best = run; }
    else run = null;
  }
  // current: today may still be 0 without breaking the streak
  let i = cal.length - 1;
  if (i >= 0 && cal[i][1] === 0) i--;
  let cur = { len: 0, start: cal.at(-1)?.[0], end: cal.at(-1)?.[0] };
  if (i >= 0 && cal[i][1] > 0) {
    const end = cal[i][0];
    let len = 0;
    while (i >= 0 && cal[i][1] > 0) { len++; i--; }
    cur = { len, start: cal[i + 1][0], end };
  }
  const first = cal.find(([, c]) => c > 0)?.[0] || cal[0]?.[0];
  const range = (a, b) => (a === b ? day(a) : `${day(a)} – ${day(b)}`);
  const col = (x, big, label, sub, color, delay) => `<g class="fade" style="animation-delay:${delay}ms" transform="translate(${x} 0)">
  <text class="big" text-anchor="middle" y="92" style="fill:${color}">${big}</text>
  <text class="l" text-anchor="middle" y="122" style="font-weight:400">${label}</text>
  <text class="s" text-anchor="middle" y="145" style="fill:${C.muted};font-size:11px">${sub}</text></g>`;
  return frame(495, 195, `
<line x1="165" y1="30" x2="165" y2="165" stroke="${C.border}"/><line x1="330" y1="30" x2="330" y2="165" stroke="${C.border}"/>
${col(82.5, fmt(total), 'Total Contributions', `${day(first)} – Present`, C.title, 100)}
<g transform="translate(247.5 0)">
  <circle cy="72" r="40" fill="none" stroke="${C.accent}" stroke-width="5"/>
  <path transform="translate(-9 18)" fill="${C.accent}" d="M9 0c1 4 7 6 7 12a7 7 0 0 1-14 0c0-3 2-5 3-6 0 2 1 3 2 3 0-4 2-6 2-9Z"/>
</g>
${col(247.5, cur.len, 'Current Streak', cur.len ? range(cur.start, cur.end) : 'Start one today', C.accent, 250).replace('y="92"', 'y="82"').replace('y="122"', 'y="140"').replace('y="145"', 'y="160"')}
${col(412.5, fmt(best.len), 'Longest Streak', best.len ? range(best.start, best.end) : '—', C.title, 400)}`, 'Contribution streak');
}

function activityCard(d) {
  const last = d.calendar.slice(-31);
  const W = 860, H = 300, L = 55, R = 25, T = 60, B = 55;
  const max = Math.max(4, ...last.map(([, c]) => c));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const px = (i) => L + (i * (W - L - R)) / (last.length - 1);
  const py = (v) => T + (H - T - B) * (1 - v / top);
  const pts = last.map(([, c], i) => [px(i), py(c)]);
  // smooth path (Catmull-Rom → Bézier)
  let line = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    // clamp control points between the two endpoints → no overshoot above peaks or below zero
    const lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]);
    const cl = (v) => Math.max(lo, Math.min(hi, v));
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, cl(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, cl(p2[1] - (p3[1] - p1[1]) / 6)];
    line += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const area = `${line} L${pts.at(-1)[0].toFixed(1)},${py(0)} L${pts[0][0].toFixed(1)},${py(0)} Z`;
  const grid = [0, 1, 2, 3, 4].map((k) => `<line x1="${L}" x2="${W - R}" y1="${py(k * step).toFixed(1)}" y2="${py(k * step).toFixed(1)}" stroke="${C.border}" stroke-dasharray="3 4"/><text class="s" x="${L - 10}" y="${(py(k * step) + 4).toFixed(1)}" text-anchor="end">${k * step}</text>`).join('');
  const xs = last.map(([date], i) => `<text class="s" x="${px(i).toFixed(1)}" y="${H - B + 20}" text-anchor="middle" style="font-size:11px">${Number(date.slice(8))}</text>`).join('');
  const dots = pts.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${C.title}"/>`).join('');
  const total30 = last.reduce((s, [, c]) => s + c, 0);
  return frame(W, H, `<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.title}" stop-opacity=".35"/><stop offset="1" stop-color="${C.title}" stop-opacity="0"/></linearGradient>
<clipPath id="reveal"><rect x="0" y="0" width="0" height="${H}"><animate attributeName="width" from="0" to="${W}" dur="1.4s" fill="freeze"/></rect></clipPath></defs>
<text class="t" x="${W / 2}" y="35" text-anchor="middle">Contributions · last 31 days</text>
<text class="s" x="${W - R}" y="35" text-anchor="end" style="fill:${C.muted}">${fmt(total30)} total</text>
${grid}${xs}
<g clip-path="url(#reveal)"><path d="${area}" fill="url(#ag)"/><path d="${line}" fill="none" stroke="${C.title}" stroke-width="2.5"/>${dots}</g>`, 'Contributions in the last 31 days');
}

const data = await fetchData();
await mkdir('assets', { recursive: true });
await Promise.all([
  writeFile('assets/stats.svg', statsCard(data)),
  writeFile('assets/langs.svg', langsCard(data)),
  writeFile('assets/streak.svg', streakCard(data)),
  writeFile('assets/activity.svg', activityCard(data)),
]);
console.log(`cards: stars=${data.stars} commits=${data.commits} prs=${data.prs} issues=${data.issues} repos=${data.repos} days=${data.calendar.length} langs=${data.langs.length}`);
