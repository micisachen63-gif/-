import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

// Text extensions worth snapshotting for diff/rollback. Mirrors local-maintenance TEXT_EXT.
export const GROK_SNAPSHOT_TEXT_EXT = new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.json','.md','.ps1','.cmd','.bat','.sh','.html','.css','.scss','.txt','.yml','.yaml','.toml','.ini','.xml','.sql','.csv','.tsv']);
// Directories and files never snapshotted (secrets, build junk, large/binary trees).
const SNAP_BLOCKED = /(^|[\\/])(?:node_modules|\.git|\.auth|browser-profile|\.video-deps|private|backup|backups|logs|state|assets|output|\.grok)(?:[\\/]|$)|(?:^|[\\/])(?:\.env(?:\..*)?|relay\.local\.json|telegram\.local\.json|tdx\.local\.json|backend-credentials[^\\/]*|[^\\/]*\.dpapi[^\\/]*|credentials?\.json|youtube-(?:token|client)\.json)$/i;
const MAX_SNAP = 262_144; // 256 KB per file

// Secrets and destructive commands Grok Build must never read, edit, or run.
// deny > ask > allow, and Read/Edit deny rules also apply to shell commands touching those paths.
export const GROK_DENY_RULES = [
  // secrets: never read or edit (also enforced on shell commands that touch these paths)
  ...['**/backend-credentials*','**/*.dpapi*','**/telegram.local.json','**/relay.local.json','**/tdx.local.json','**/.env','**/.env.*',
      '**/.auth/**','**/private/**','**/credentials.json','**/credential.json','**/.grok/auth.json','**/.codex/**','**/.grokbot/**','**/.ssh/**']
    .flatMap((g) => [`Read(${g})`, `Edit(${g})`]),
  // system / other apps: never edit
  ...['C:/Windows/**','C:/Program Files/**','C:/Program Files (x86)/**','C:/Users/User/AppData/**','C:/Users/User/Desktop/**','C:/Users/User/.grok/**','C:/Users/User/Documents/ChatGPT/神殿守望者/**']
    .map((g) => `Edit(${g})`),
  // destructive or out-of-band shell commands (schedules/services go through the bot's own verified path).
  // Distinctive tokens are blocked anywhere in the command; short/common words only as the command prefix.
  ...['rm -rf','Remove-Item','diskpart','bcdedit','reg delete','reg add','schtasks','Register-ScheduledTask',
      'Unregister-ScheduledTask','Set-ScheduledTask','Stop-ScheduledTask','taskkill','Stop-Process','Restart-Computer',
      'Stop-Computer','git push','npm publish','Set-ExecutionPolicy','Invoke-WebRequest','Invoke-RestMethod',
      'api.telegram.org','watchdog.ps1','stop.cmd','start.cmd','index.js service','service.mjs','grok login','grok logout',
      'backend-credentials','.dpapi','telegram.local.json','relay.local.json','tdx.local.json']
    .flatMap((c) => [`Bash(${c}*)`, `Bash(*${c}*)`]),
  ...['format','rd ','rmdir','del ','erase','cipher','shutdown','iwr','irm','curl','wget','ssh','scp']
    .map((c) => `Bash(${c}*)`),
  'WebFetch','WebSearch',
];
// Shell is allow-listed (dontAsk denies everything else). Verified on Windows 2026-10-02 that a bare
// 'Bash' allow let `node -e` / `cmd /c echo > %USERPROFILE%\x` write outside --cwd; file edits go through
// the Edit tool, which honours the path deny rules. Inspection + project tests only; no installs, no ad-hoc node -e.
export const GROK_BASH_ALLOW = ['npm test','npm.cmd test','npm run test','node --test','node --check','node --version','node -v',
  'git status','git diff','git log','Get-ChildItem','Get-Content','Select-String','Test-Path','Get-Item','Get-Command',
  'dir','ls','type ','cat ','where ','findstr','Measure-Object'];
export const GROK_ALLOW_RULES = ['Read','Grep','Edit(**)',...GROK_BASH_ALLOW.map((c) => `Bash(${c}*)`)];
export const GROK_RULES_TEXT = '請用檔案編輯工具修改檔案（不要用 shell 指令寫檔），終端機只用來檢視與執行 npm test / node --test；請只修改與這次需求直接相關的檔案，保持改動最小；不得讀取、輸出或修改任何帳密、API 金鑰、token、.env、*.dpapi*、backend-credentials*、telegram.local.json、relay.local.json、tdx.local.json 或 .auth 內容；完成後請執行專案既有測試並確保通過；若無法在不破壞現有功能的前提下安全完成，請停止並清楚說明原因。';

// Windows does not enforce the sandbox write limit (verified 2026-10-02: an Edit outside --cwd succeeded),
// so emulate "edits only inside cwd": deny Edit for files directly in every ancestor folder and for every
// sibling folder along the path from the drive root down to cwd, plus other drives.
export function editScopeDenies(target, { listDirs = defaultListDirs, otherDrives = ['D', 'E', 'F', 'G'] } = {}) {
  const P = /^[A-Za-z]:[\\/]/.test(String(target)) ? path.win32 : path.posix;
  const fwd = (x) => String(x).replaceAll('\\', '/').replace(/\/+$/, '');
  const abs = P.resolve(String(target));
  const chain = [];
  for (let cur = abs; ; ) { const parent = P.dirname(cur); if (parent === cur) break; chain.unshift({ parent, child: cur }); cur = parent; }
  const rules = [];
  for (const { parent, child } of chain) {
    const base = fwd(parent);
    rules.push(`Edit(${base}/*)`);
    for (const name of listDirs(parent)) {
      const full = P.join(parent, name);
      if (full.toLowerCase() === child.toLowerCase()) continue;
      rules.push(`Edit(${fwd(full)}/**)`);
    }
  }
  if (P === path.win32) { const drive = abs[0].toUpperCase(); for (const d of otherDrives) if (d !== drive) rules.push(`Edit(${d}:/**)`); }
  return [...new Set(rules)];
}
function defaultListDirs(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } }

export function buildGrokArgs({ promptFile, cwd, model = null, maxTurns = 30, sandbox = 'workspace', permissionMode = 'dontAsk', allow = GROK_ALLOW_RULES, deny = GROK_DENY_RULES, rules = GROK_RULES_TEXT, scope = true, listDirs } = {}) {
  if (!promptFile || !cwd) throw new Error('buildGrokArgs 需要 promptFile 與 cwd');
  const args = ['--no-auto-update', '--prompt-file', promptFile, '--cwd', cwd,
    '--output-format', 'json', '--permission-mode', permissionMode,
    '--sandbox', sandbox, '--max-turns', String(maxTurns),
    '--no-subagents', '--disable-web-search'];
  if (model) args.push('-m', model);
  if (rules) args.push('--rules', rules);
  for (const r of (allow || GROK_ALLOW_RULES)) args.push('--allow', r);
  for (const r of [...(deny || GROK_DENY_RULES), ...(scope ? editScopeDenies(cwd, listDirs ? { listDirs } : {}) : [])]) args.push('--deny', r);
  return args;
}

export function snapshotProject(root) {
  const map = new Map();
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (SNAP_BLOCKED.test(full)) continue;
      if (e.isDirectory()) { walk(full); continue; }
      if (!GROK_SNAPSHOT_TEXT_EXT.has(path.extname(full).toLowerCase())) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.size > MAX_SNAP) continue;
      const content = fs.readFileSync(full);
      map.set(path.relative(root, full).replaceAll('\\', '/'), { hash: createHash('sha256').update(content).digest('hex'), content });
    }
  };
  if (fs.existsSync(root)) walk(root);
  return map;
}

export function diffSnapshot(before, after) {
  const created = [], modified = [], deleted = [];
  for (const rel of after.keys()) {
    if (!before.has(rel)) created.push(rel);
    else if (before.get(rel).hash !== after.get(rel).hash) modified.push(rel);
  }
  for (const rel of before.keys()) if (!after.has(rel)) deleted.push(rel);
  return { created, modified, deleted };
}

export function parseGrokJson(out) {
  const s = String(out || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

export function spawnGrokBuild({ grokExe, args, cwd, timeoutMs = 600_000, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(grokExe, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }); }
    catch (e) { resolve({ code: null, out: '', err: e.message }); return; }
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b; if (out.length > 2_000_000) out = out.slice(-2_000_000); });
    child.stderr.on('data', (b) => { err += b; if (err.length > 200_000) err = err.slice(-200_000); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: null, out, err: err + '\n逾時', timedOut: true }); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// Pick the target project for a GROK task. Explicit "專案:key" wins; otherwise keyword match; default fairy.
export function pickGrokProject(text, projects) {
  const s = String(text || '');
  const explicit = /專案\s*[:：=]\s*([A-Za-z_]+)/.exec(s)?.[1];
  if (explicit && projects[explicit]) return explicit;
  const rules = [
    ['daily_gift', /新手禮包|禮包|daily[_ ]?gift/i],
    ['monthly_report', /月報簡報|月報|monthly[_ -]?report/i],
    ['back_to_work', /上班提醒|收假提醒|back[_ -]?to[_ -]?work/i],
    ['weekend_picks', /週末推薦|weekend[_ -]?picks/i],
    ['song_slots', /爽爆.{0,8}(選台|機台|狙擊)|爽爆機台狙擊手|song[_ -]?slots/i],
    ['qiezi_slots', /茄子.{0,8}(選台|機台|狙擊)|茄子機台狙擊手|qiezi[_ -]?slots/i],
    ['atg_slots', /贏麻.{0,8}(選台|機台|狙擊)|贏麻了選台|atg[_ -]?slots/i],
    ['daily_fortune', /每日運勢|澄.{0,4}運勢|daily[_ -]?fortune/i],
    ['daily_digest', /八卦新聞|八卦通知|每日新聞|daily[_ -]?digest/i],
    ['operations', /營運(數據|報表|程式)?|三平台|報表|operations/i],
    ['fairy', /小精靈|爆分|出金|監控|塔羅|嘻哈|today-food|fairy/i],
  ];
  for (const [key, re] of rules) if (projects[key] && re.test(s)) return key;
  return projects.fairy ? 'fairy' : Object.keys(projects)[0];
}

// Persist a full pre-run copy so a crash mid-run can still be rolled back.
export function writeSnapshot(snap, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {};
  for (const [rel, { hash, content }] of snap) { const dst = path.join(dir, 'files', rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, content); manifest[rel] = hash; }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

// Restore root to the snapshot stored in dir; returns what was undone. Throws if verification fails.
export function restoreSnapshot(root, dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const now = snapshotProject(root);
  const before = new Map(Object.entries(manifest).map(([rel, hash]) => [rel, { hash }]));
  const d = diffSnapshot(before, now);
  for (const rel of [...d.modified, ...d.deleted]) { const full = path.join(root, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.copyFileSync(path.join(dir, 'files', rel), full); }
  for (const rel of d.created) { const full = path.resolve(root, rel); if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('還原路徑超出專案：' + rel); fs.rmSync(full, { force: true }); }
  const check = diffSnapshot(before, snapshotProject(root));
  if (check.created.length || check.modified.length || check.deleted.length) throw new Error('還原後核對不一致：' + [...check.created, ...check.modified, ...check.deleted].slice(0, 5).join(', '));
  return d;
}

// Save the failed attempt's changed files for reference (no secrets: snapshot already excludes them).
export function saveAttempt(root, dir, d) {
  for (const rel of [...d.created, ...d.modified]) { const src = path.join(root, rel); if (!fs.existsSync(src)) continue; const dst = path.join(dir, 'attempt', rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
}

// Post-run backstop: Windows ignores the sandbox write limit, so after every run look for files changed
// outside the project since the run started. Detect-only (never deletes outside files); any hit fails the job.
const WATCH_SKIP = /(^|[\\/])(?:node_modules|\.git|logs|state|browser-profile|\.auth|\.cache|\.grok|\.codex|\.grokbot|AppData|private|backup|backups|chrome|chatgpt-chrome|Cookies|GPUCache|Code Cache|Cache)(?:[\\/]|$)/i;
export function defaultWatchRoots(target) {
  const home = process.env.USERPROFILE || path.dirname(path.dirname(String(target)));
  return [path.join(home, 'Documents'), path.join(home, 'Desktop'), path.join(home, 'Downloads'), home];
}
export function scanOutsideChanges(target, sinceMs, { roots = defaultWatchRoots(target), maxDepth = 6, maxEntries = 60000, skip = WATCH_SKIP } = {}) {
  const t = path.resolve(target).toLowerCase(); const hits = []; let seen = 0;
  const walk = (dir, depth, topOnly) => {
    if (seen > maxEntries || hits.length >= 50) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name); seen++;
      if (full.toLowerCase() === t || full.toLowerCase().startsWith(t + path.sep)) continue;
      if (skip.test(full) || e.isSymbolicLink() || /^ntuser/i.test(e.name)) continue; // junctions like Recent/My Documents, registry hive logs
      if (e.isDirectory()) { if (!topOnly && depth < maxDepth) walk(full, depth + 1, false); continue; }
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs >= sinceMs || st.birthtimeMs >= sinceMs) hits.push(full);
    }
  };
  const uniq = [...new Set(roots.map((r) => path.resolve(r)))];
  const home = process.env.USERPROFILE ? path.resolve(process.env.USERPROFILE) : null;
  for (const r of uniq) walk(r, 0, home && r.toLowerCase() === home.toLowerCase());
  return hits;
}
