/**
 * EA Local Ops Worker
 * Polls Firebase for queued ops jobs and executes them on this machine.
 * Actions: open_vscode, open_app, search_files, draft_email
 *
 * Run: node ops-worker.js
 * Auto-start: use start-worker.ps1
 */

const https = require('https');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const admin = require('firebase-admin');

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'worker-config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {
  console.error('[worker] ERROR: Cannot read worker-config.json. Run setup first.');
  process.exit(1);
}

const {
  HOST_MONITOR_TOKEN,
  OWNER_ID,
  DEVICE_ID = os.hostname(),
  INDEX_URL  = 'https://us-central1-ramdesignworks-exec-staff.cloudfunctions.net/updateMachineIndex',
  PROJECTS_ROOT = 'D:\\BUSINESS',
  SERVICE_ACCOUNT_PATH = './service-account.json',
} = config;

// ── Firebase Admin init ───────────────────────────────────────────────────────
const saPath = path.resolve(__dirname, SERVICE_ACCOUNT_PATH);
if (!fs.existsSync(saPath)) {
  console.error(`[worker] ERROR: Service account key not found at: ${saPath}`);
  console.error('[worker] Download it from Firebase Console > Project Settings > Service Accounts > Generate New Private Key');
  console.error('[worker] Save as worker/service-account.json then restart.');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(saPath, 'utf8'))) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

if (!HOST_MONITOR_TOKEN || !OWNER_ID) {
  console.error('[worker] ERROR: HOST_MONITOR_TOKEN and OWNER_ID are required in worker-config.json');
  process.exit(1);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-host-monitor-token': HOST_MONITOR_TOKEN,
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Job updater — writes directly to Firestore ───────────────────────────────
async function updateJob(jobId, status, message, resultSummary = null, error = null) {
  try {
    const update = {
      status,
      message: String(message || '').trim().slice(0, 500),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (resultSummary !== null) update.resultSummary = String(resultSummary).slice(0, 500);
    if (error !== null) update.error = String(error).slice(0, 500);
    await db.collection('ops_jobs').doc(jobId).update(update);
    console.log(`[worker] Job ${jobId} → ${status}: ${message}`);
  } catch (err) {
    console.error(`[worker] Failed to update job ${jobId}:`, err.message);
  }
}

// ── App name → executable map (Windows) ──────────────────────────────────────
function resolveApp(appName) {
  const name = (appName || '').toLowerCase().trim();
  const map = {
    'vs code':        'code',
    'vscode':         'code',
    'visual studio code': 'code',
    'chrome':         'chrome',
    'google chrome':  'chrome',
    'edge':           'msedge',
    'microsoft edge': 'msedge',
    'notepad':        'notepad',
    'notepad++':      'notepad++',
    'explorer':       'explorer',
    'file explorer':  'explorer',
    'outlook':        'outlook',
    'word':           'winword',
    'excel':          'excel',
    'powerpoint':     'powerpnt',
    'slack':          'slack',
    'zoom':           'zoom',
    'spotify':        'spotify',
    'calculator':     'calc',
    'terminal':       'wt',
    'windows terminal': 'wt',
    'powershell':     'powershell',
    'cmd':            'cmd',
    'command prompt': 'cmd',
  };
  return map[name] || name;
}

// ── Find project folder ───────────────────────────────────────────────────────
function findProject(projectName) {
  const name = (projectName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const roots = [
    PROJECTS_ROOT,                          // D:\BUSINESS — priority match, deep scan
    'D:\\',                                 // full D drive — top 2 levels
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Desktop'),
    'C:\\Projects',
    'D:\\Projects',
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const normalized = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalized.includes(name) || name.includes(normalized)) {
          const fullPath = path.join(root, entry.name);
          // Also check one level deep (e.g. BUSINESS/9 CLIENT/ProjectName)
          return fullPath;
        }
      }
      // One level deeper
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subRoot = path.join(root, entry.name);
        try {
          const subEntries = fs.readdirSync(subRoot, { withFileTypes: true });
          for (const sub of subEntries) {
            if (!sub.isDirectory()) continue;
            const normalized = sub.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (normalized.includes(name) || name.includes(normalized)) {
              return path.join(subRoot, sub.name);
            }
          }
        } catch { /* skip unreadable dirs */ }
      }
    } catch { /* skip unreadable roots */ }
  }
  return null;
}

// ── Action handlers ───────────────────────────────────────────────────────────
async function handleOpenVscode(job) {
  // instruction may be at top level OR inside metadata
  const topInstruction = job.instruction || '';
  const { projectPath, projectName, instruction: metaInstruction } = job.metadata || {};
  const instruction = metaInstruction || topInstruction;

  let targetPath = projectPath || null;

  // If no explicit path, search by name
  if (!targetPath && projectName) {
    targetPath = findProject(projectName);
  }
  // Try to extract from instruction text
  if (!targetPath && instruction) {
    // Try each word ≥ 5 chars as a potential project name
    const words = instruction.split(/\s+/).filter(w => w.length >= 5 && /^[a-z]/i.test(w));
    for (const word of words) {
      const found = findProject(word.replace(/[^a-z0-9]/gi, ''));
      if (found) { targetPath = found; break; }
    }
  }

  if (targetPath && fs.existsSync(targetPath)) {
    await updateJob(job.id, 'in_progress', `Opening VS Code at: ${targetPath}`);
    exec(`code "${targetPath}"`, async (err) => {
      if (err) {
        await updateJob(job.id, 'failed', `Failed to open VS Code`, null, err.message);
      } else {
        await updateJob(job.id, 'done', `VS Code opened at ${targetPath}`, `Opened: ${path.basename(targetPath)}`);
      }
    });
  } else {
    // Fall back: open VS Code with no folder, show message
    const searched = projectName || instruction || 'the project';
    exec(`code`, async (err) => {
      if (err) {
        await updateJob(job.id, 'failed', `Could not open VS Code`, null, err.message);
      } else {
        await updateJob(job.id, 'done',
          `VS Code opened. I couldn't find a folder matching "${searched}" automatically — you can open it manually from File > Open Folder.`,
          'VS Code launched'
        );
      }
    });
  }
}

async function handleOpenApp(job) {
  const { appName, instruction: metaInstruction } = job.metadata || {};
  const instruction = metaInstruction || job.instruction || '';
  const resolved = resolveApp(appName || instruction || '');
  await updateJob(job.id, 'in_progress', `Launching ${appName || resolved}...`);
  exec(`start "" "${resolved}"`, { shell: true }, async (err) => {
    if (err) {
      // Try alternate shell launch
      exec(`${resolved}`, async (err2) => {
        if (err2) {
          await updateJob(job.id, 'failed', `Could not launch ${appName}`, null, err2.message);
        } else {
          await updateJob(job.id, 'done', `${appName} launched.`, `Opened ${appName}`);
        }
      });
    } else {
      await updateJob(job.id, 'done', `${appName || resolved} launched.`, `Opened ${appName || resolved}`);
    }
  });
}

async function handleSearchFiles(job) {
  const { fileQuery, instruction } = job.metadata || {};
  const query = fileQuery || instruction || '';
  await updateJob(job.id, 'in_progress', `Searching for files matching: ${query}`);

  // Open Windows Explorer search across entire D drive
  exec(`explorer "search-ms:query=${encodeURIComponent(query)}&crumb=location:${encodeURIComponent('D:\\')}"`, async (err) => {
    if (err) {
      // Fallback: open explorer at D drive root
      exec(`explorer "D:\\"`, async () => {
        await updateJob(job.id, 'done',
          `I opened File Explorer at D:\\. Use the search bar to find "${query}".`,
          `Explorer opened`
        );
      });
    } else {
      await updateJob(job.id, 'done', `File Explorer opened with search for "${query}" across D:\\.`, `Search: ${query}`);
    }
  });
}

async function handleDraftEmail(job) {
  const { emailTo = '', emailSubject = '', emailBody = '' } = job.metadata || {};
  const mailto = `mailto:${encodeURIComponent(emailTo)}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`;
  await updateJob(job.id, 'in_progress', `Opening email client to draft message to ${emailTo}...`);
  exec(`start "" "${mailto}"`, { shell: true }, async (err) => {
    if (err) {
      await updateJob(job.id, 'failed', `Could not open email client`, null, err.message);
    } else {
      await updateJob(job.id, 'done',
        `Email draft opened${emailTo ? ' to ' + emailTo : ''}${emailSubject ? ' — Subject: ' + emailSubject : ''}.`,
        `Draft created`
      );
    }
  });
}

async function handleOpenMaps(job) {
  const { mapsUrl } = job.metadata || {};
  const url = mapsUrl || `https://www.google.com/maps`;
  await updateJob(job.id, 'in_progress', `Opening Google Maps...`);
  exec(`start "" "${url}"`, { shell: true }, async (err) => {
    if (err) {
      // Try PowerShell fallback
      exec(`powershell -Command "Start-Process '${url}'"`, async (err2) => {
        if (err2) {
          await updateJob(job.id, 'failed', `Could not open Google Maps`, null, err2.message);
        } else {
          await updateJob(job.id, 'done', `Google Maps opened in browser.`, `Maps opened`);
        }
      });
    } else {
      await updateJob(job.id, 'done', `Google Maps opened in browser.`, `Maps opened`);
    }
  });
}

// ── Job dispatcher ────────────────────────────────────────────────────────────
function buildApprovalPreview(job, action) {
  const m = job.metadata || {};
  if (action === 'open_vscode' || action === 'vscode_project_task') {
    const target = m.projectPath || m.projectName || job.instruction || 'your project';
    return `I'd like to open VS Code for: "${target}". Approve to proceed.`;
  }
  if (action === 'open_app' || action === 'desktop_open_app') {
    return `I'd like to launch: ${m.appName || 'an application'}. Approve to proceed.`;
  }
  if (action === 'draft_email') {
    return `I'd like to draft an email to ${m.emailTo || 'a recipient'}. Approve to proceed.`;
  }
  return `Approval needed for: ${action}`;
}

async function executeJob(job) {
  const action = (job.metadata?.action || job.type || '').toLowerCase();
  console.log(`[worker] Executing job ${job.id} — action: ${action}`);

  switch (action) {
    case 'open_vscode':
    case 'vscode_project_task':
      await handleOpenVscode(job);
      break;
    case 'open_app':
    case 'desktop_open_app':
      await handleOpenApp(job);
      break;
    case 'search_files':
      await handleSearchFiles(job);
      break;
    case 'draft_email':
      await handleDraftEmail(job);
      break;
    case 'open_maps':
      await handleOpenMaps(job);
      break;
    default:
      await updateJob(job.id, 'failed',
        `Unknown action type: "${action}". This worker doesn't know how to handle it yet.`,
        null, `Unsupported action: ${action}`
      );
  }
}

// ── Machine Index Scanner ────────────────────────────────────────────────────
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', 'venv', '.venv', 'env', '.env', 'vendor', 'bower_components',
  '$recycle.bin', 'system volume information', 'windows', 'temp', 'tmp',
  // Security / AV / system-critical folders — skip to avoid permission errors and leaking sensitive paths
  'windows defender', 'windows security', 'microsoft security client',
  'windowsapps', 'winsxs', 'system32', 'syswow64', 'sysarm32',
  'secureboot', 'tpm', 'catroot', 'catroot2', 'codeintegrity',
  'drivers', 'inf', 'prefetch', 'servicing', 'assembly',
  'cng', 'fvenotify', 'hvci', 'windowsazure',
]);

function scanDir(dirPath, depth = 0, maxDepth = 4) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dirPath, entry.name);
      results.push({ name: entry.name, path: fullPath, depth });
      if (depth < maxDepth) results.push(...scanDir(fullPath, depth + 1, maxDepth));
    }
  } catch { /* skip unreadable */ }
  return results;
}

function collectShortcuts(dir, results = [], depth = 0) {
  if (depth > 2 || !fs.existsSync(dir)) return results;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) collectShortcuts(path.join(dir, e.name), results, depth + 1);
      else if (e.name.endsWith('.lnk') || e.name.endsWith('.url'))
        results.push(e.name.replace(/\.(lnk|url)$/i, ''));
    }
  } catch { /* skip */ }
  return results;
}

async function scanAndUploadIndex() {
  console.log('[worker] Scanning machine...');
  try {
    // Installed apps from Program Files (C and D drives)
    const appFolders = [
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'D:\\Program Files',
      'D:\\Program Files (x86)',
      'D:\\Apps',
    ];
    const apps = [...new Set(
      appFolders.flatMap(d => scanDir(d, 0).filter(e => e.depth === 0).map(e => e.name))
    )].sort();

    // Project folders — shallow scan of full D:\ (2 levels) + deep scan under PROJECTS_ROOT (6 levels)
    const seen = new Set();
    const rawProjects = [
      ...scanDir('D:\\', 0, 2),          // full D drive, top-level + 2 levels deep
      ...scanDir(PROJECTS_ROOT, 0, 6),   // deep business root
    ];
    const projects = rawProjects
      .filter(e => { if (seen.has(e.path)) return false; seen.add(e.path); return true; })
      .map(e => ({ name: e.name, path: e.path, depth: e.depth }));

    // Start Menu shortcuts
    const startMenuDirs = [
      path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
    ];
    const shortcuts = [...new Set(startMenuDirs.flatMap(d => collectShortcuts(d)))].sort();

    // Desktop
    const desktopDirs = [
      path.join(os.homedir(), 'Desktop'),
      'C:\\Users\\Public\\Desktop',
    ];
    const desktop = [...new Set(desktopDirs.flatMap(d => collectShortcuts(d)))].sort();

    const payload = {
      ownerId: OWNER_ID,
      deviceId: DEVICE_ID,
      apps,
      projects,
      shortcuts,
      desktop,
      scannedAt: new Date().toISOString(),
    };

    const res = await post(INDEX_URL, payload);
    if (res.status === 200) {
      console.log(`[worker] Index uploaded: ${apps.length} apps, ${projects.length} folders, ${shortcuts.length} shortcuts`);
    } else {
      console.error('[worker] Index upload failed:', res.status, JSON.stringify(res.body));
    }
  } catch (err) {
    console.error('[worker] Scan error:', err.message);
  }
}

// ── Firestore real-time job listener ─────────────────────────────────────────
let unsubscribeListener = null;

function startJobListener() {
  if (unsubscribeListener) { try { unsubscribeListener(); } catch {} }

  const query = db.collection('ops_jobs')
    .where('ownerId', '==', OWNER_ID)
    .where('status', 'in', ['queued', 'approved']);

  unsubscribeListener = query.onSnapshot(
    async (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue;
        const doc = change.doc;
        const data = doc.data();
        // Safety check: skip if already claimed by the time snapshot fires
        if (data.status !== 'queued' && data.status !== 'approved') continue;

        console.log(`[worker] Got job: ${doc.id} (${data.metadata?.action || data.type})`);

        // Claim it immediately to prevent duplicate execution
        try {
          await doc.ref.update({
            status: 'in_progress',
            claimedBy: DEVICE_ID,
            claimedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } catch (err) {
          console.error(`[worker] Failed to claim job ${doc.id}:`, err.message);
          continue;
        }

        await executeJob({ id: doc.id, ...data });
      }
    },
    (err) => {
      console.error('[worker] Firestore listener error:', err.message);
      console.log('[worker] Reconnecting in 10s...');
      unsubscribeListener = null;
      setTimeout(startJobListener, 10000);
    }
  );

  console.log('[worker] Listening for jobs in real-time (onSnapshot)...');
}

// ── Start ─────────────────────────────────────────────────────────────────────
console.log(`[worker] EA Local Ops Worker starting on ${DEVICE_ID}`);
console.log(`[worker] Owner: ${OWNER_ID}`);
console.log(`[worker] Polling every ${POLL_INTERVAL_MS / 1000}s`);
console.log(`[worker] Projects root: ${PROJECTS_ROOT}`);
console.log('[worker] Ready — waiting for jobs...\n');

startJobListener();

// Machine index: scan immediately on start
scanAndUploadIndex();

// ── Daily midnight refresh — keeps project folder index current ──────────────
function scheduleMidnightRefresh() {
  const now = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  const msUntil = next.getTime() - now.getTime();
  setTimeout(() => {
    console.log('[worker] Running daily midnight index refresh...');
    scanAndUploadIndex().then(() => scheduleMidnightRefresh());
  }, msUntil);
  console.log(`[worker] Daily refresh scheduled for ${next.toLocaleString()}`);
}
scheduleMidnightRefresh();

// ── Weekly audit — every Saturday at 4:00 AM ─────────────────────────────────
function scheduleSaturdayAudit() {
  const now = new Date();
  const next = new Date(now);

  // Advance to next Saturday (day 6)
  const daysUntilSat = (6 - now.getDay() + 7) % 7 || 7; // always at least 1 week out if today is Sat but past 4am
  next.setDate(now.getDate() + daysUntilSat);
  next.setHours(4, 0, 0, 0);

  // If today IS Saturday and it's before 4 AM, run this Saturday instead
  if (now.getDay() === 6 && now.getHours() < 4) {
    next.setDate(now.getDate());
    next.setHours(4, 0, 0, 0);
  }

  const msUntilNext = next.getTime() - now.getTime();
  console.log(`[worker] Weekly audit scheduled for ${next.toLocaleString()} (in ${Math.round(msUntilNext / 3600000)}h)`);

  setTimeout(() => {
    console.log('[worker] Running scheduled Saturday 4AM program audit...');
    scanAndUploadIndex().then(() => {
      console.log('[worker] Saturday audit complete. Scheduling next week.');
      scheduleSaturdayAudit(); // reschedule for next Saturday
    });
  }, msUntilNext);
}
scheduleSaturdayAudit();
