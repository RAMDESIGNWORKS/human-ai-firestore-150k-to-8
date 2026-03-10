const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const OpenAI = require('openai');
const { defineSecret } = require('firebase-functions/params');

initializeApp();
const db = getFirestore();

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const AUTOMATION_WEBHOOK_URL = defineSecret('AUTOMATION_WEBHOOK_URL');
const AUTOMATION_CALLBACK_TOKEN = defineSecret('AUTOMATION_CALLBACK_TOKEN');
const BROWSER_COMPANION_TOKEN = defineSecret('BROWSER_COMPANION_TOKEN');
const HOST_MONITOR_TOKEN = defineSecret('HOST_MONITOR_TOKEN');
const GOOGLE_CLIENT_ID = defineSecret('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
const GOOGLE_MAPS_API_KEY = defineSecret('GOOGLE_MAPS_API_KEY');

function safeText(value, max = 500) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function buildGuidance(snapshot) {
  const title = safeText(snapshot.title, 140) || 'this page';
  const mainAction = safeText(snapshot.primaryAction, 160);
  const helpHints = Array.isArray(snapshot.helpLinks)
    ? snapshot.helpLinks.map((h) => safeText(h, 120)).filter(Boolean).slice(0, 3)
    : [];

  const steps = [];
  steps.push(`Confirm you are on the correct screen: ${title}.`);
  if (mainAction) {
    steps.push(`Use the primary action shown on this page: ${mainAction}.`);
  } else {
    steps.push('Look for the top-right primary button (for example: New, Create, Continue, Save, or Send).');
  }
  steps.push('Complete required fields first (marked with * or shown in red).');
  if (helpHints.length > 0) {
    steps.push(`If you get stuck, open: ${helpHints.join(' | ')}.`);
  } else {
    steps.push('If you get stuck, open the on-page Help, Docs, or Support link.');
  }
  steps.push('Before final submit, review recipient, date/time, and confirmation details.');

  return {
    mode: 'guide',
    summary: `Guidance ready for ${title}.`,
    steps,
    caution: 'For security, credentials and password fields are never collected by the companion.',
  };
}

function safeArray(values, maxItems = 100, maxLen = 300) {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => safeText(String(v), maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function tokenize(text) {
  return safeText(text || '', 500)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function scoreProgramMatch(queryTokens, app) {
  const hay = [app.name, app.publisher, app.installLocation, app.version]
    .map((v) => safeText(v || '', 300).toLowerCase())
    .join(' ');

  let score = 0;
  for (const token of queryTokens) {
    if (hay.includes(token)) score += 1;
  }

  // Heuristic boosts for common intent terms.
  const appName = safeText(app.name || '', 200).toLowerCase();
  if (queryTokens.includes('pdf') && /acrobat|foxit|pdf|word/.test(appName)) score += 2;
  if ((queryTokens.includes('slide') || queryTokens.includes('presentation') || queryTokens.includes('powerpoint')) && /powerpoint|impress/.test(appName)) score += 2;
  if ((queryTokens.includes('spreadsheet') || queryTokens.includes('excel')) && /excel|sheets|calc/.test(appName)) score += 2;
  if ((queryTokens.includes('letter') || queryTokens.includes('document') || queryTokens.includes('doc')) && /word|writer|docs/.test(appName)) score += 2;
  if ((queryTokens.includes('call') || queryTokens.includes('meeting') || queryTokens.includes('dial')) && /teams|zoom|skype/.test(appName)) score += 2;

  return score;
}

function daysBetween(now, then) {
  const ms = now.getTime() - then.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

async function getPushEnabledUids(limit = 50) {
  const snap = await db.collectionGroup('pushTokens').limit(limit).get();
  const uids = new Set();
  snap.docs.forEach((doc) => {
    const parentUid = doc.ref.parent.parent?.id;
    if (parentUid) uids.add(parentUid);
  });
  return Array.from(uids);
}

const KEY_ROTATION_SOP = {
  cadenceDays: 90,
  reminderRepeatDays: 7,
  topic: 'projects/ramdesignworks-exec-staff/topics/secret-rotation-events',
  steps: [
    'Rotate these secrets first: HOST_MONITOR_TOKEN, AUTOMATION_CALLBACK_TOKEN, BROWSER_COMPANION_TOKEN, OPENAI_API_KEY.',
    'Use Secret Manager to add a new version for each secret and keep prior version until validation completes.',
    'Confirm Pub/Sub notifications are enabled on topic: secret-rotation-events.',
    'Deploy Functions after secret update so runtime picks up latest versions.',
    'Run smoke tests: EA chat, host monitor ingest, browser companion ingest, automation callback.',
    'After validation, disable or destroy old secret versions according to policy.'
  ],
};

const EA_TASK_STATUS = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  WAITING: 'waiting_external',
  BLOCKED: 'blocked',
  DONE: 'done',
};

const EA_TASK_PRIORITY = {
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
};

const OPS_JOB_STATUS = {
  QUEUED: 'queued',
  IN_PROGRESS: 'in_progress',
  NEEDS_APPROVAL: 'needs_approval',
  APPROVED: 'approved',
  DENIED: 'denied',
  DONE: 'done',
  FAILED: 'failed',
};

const EA_PERSONA_PROFILES = {
  chief_of_staff: 'Persona: Sharp, warm Chief of Staff. You genuinely care about how the day is going. Speak like a trusted colleague — direct, clear, occasionally funny, never flat or robotic.',
  jarvis: 'Persona: JARVIS-style operator. Calm, decisive, anticipatory, technically precise — with a dry wit and quiet confidence.',
  coach: 'Persona: Strategic coach. Engaged, encouraging, direct. Explain your reasoning briefly and focus on what actually moves the needle.',
  concise: 'Persona: Ultra concise. Short answers only unless asked. Still warm, never cold.',
};

// ============================================================
// AGENT TOOL DEFINITIONS
// Passed to GPT-4o for function calling.
// Split into two tiers:
//   AUTO_EXECUTE_TOOLS  — run immediately inside the agentic loop
//   APPROVAL_REQUIRED_TOOLS — paused, shown to user for confirm/reject
// ============================================================

const EA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information, news, research, pricing, or any topic. Use whenever the user needs current data or you lack recent knowledge.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query to run' },
          limit: { type: 'integer', description: 'Number of results (1–5)', default: 3 },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_task',
      description: 'Save a task, follow-up item, or reminder to the task tracker. Use when the user says to remember, follow up, track, or not forget something.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short task title (under 200 chars)' },
          description: { type: 'string', description: 'Optional additional detail' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          dueAt: { type: 'string', description: 'ISO 8601 due date if one was mentioned' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'queue_desktop_action',
      description: 'Queue a local desktop action (open an app, draft email, search files, open VS Code project) for the local automation runner. REQUIRES USER APPROVAL before executing.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open_app', 'search_files', 'draft_email', 'open_vscode'],
            description: 'Type of desktop action',
          },
          instruction: { type: 'string', description: 'Human-readable instruction for the runner' },
          appName: { type: 'string', description: 'App name for open_app' },
          fileQuery: { type: 'string', description: 'Search pattern for search_files' },
          emailTo: { type: 'string', description: 'Recipient email for draft_email' },
          emailSubject: { type: 'string', description: 'Subject line for draft_email' },
          emailBody: { type: 'string', description: 'Email body for draft_email' },
          projectPath: { type: 'string', description: 'Full path for open_vscode' },
          projectName: { type: 'string', description: 'Project name for open_vscode' },
        },
        required: ['action', 'instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: 'Store a persistent fact about the user, their preferences, business context, or anything the EA should always remember. Use whenever the user shares something important about themselves, their goals, or how they want things done.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'The fact to remember, written as a clear standalone statement' },
          category: {
            type: 'string',
            enum: ['preference', 'context', 'person', 'business', 'instruction', 'other'],
            description: 'Category to help organize and retrieve facts',
          },
        },
        required: ['fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_memory',
      description: 'Write structured knowledge to the shared Global Memory Layer — readable by every bot on every request. Use when you learn important information about the user, their business, active projects, key relationships, strategic goals, or EA preferences. All bots read this shared memory automatically.',
      parameters: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['user_profile', 'business', 'projects', 'relationships', 'goals', 'preferences'],
            description: 'Which section of global memory to update. user_profile/business/preferences are key-value objects (use set). projects/relationships/goals are string arrays (use append/remove).',
          },
          operation: {
            type: 'string',
            enum: ['set', 'append', 'remove'],
            description: 'set: write a key-value into an object section. append: add an item string to an array section. remove: delete an item string from an array section.',
          },
          key: {
            type: 'string',
            description: 'For set only: the field name within the section (e.g. "company_name", "timezone", "response_style")',
          },
          value: {
            type: 'string',
            description: 'The string value to set, or the item to append/remove from an array section',
          },
        },
        required: ['section', 'operation', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trigger_automation',
      description: 'Trigger an n8n/webhook automation workflow (send email, book calendar appointment, CRM update, any external action). REQUIRES USER APPROVAL before executing.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Natural language description of what the automation should do' },
          payload: {
            type: 'object',
            description: 'Optional structured data to include in the automation payload',
            properties: {},
            additionalProperties: true,
          },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'call_bot',
      description: 'Consult another specialist bot for domain-specific expert input. Use when your plan requires insight from another domain (e.g., CFO consulting Tax about deductions, COO consulting CPO about a build decision). Returns that bot\'s analysis. Do NOT call yourself. Do NOT call EA.',
      parameters: {
        type: 'object',
        properties: {
          bot: {
            type: 'string',
            enum: ['CFO', 'Tax', 'Legal', 'COO', 'CMO', 'CPO'],
            description: 'The specialist bot to consult',
          },
          question: {
            type: 'string',
            description: 'The specific question or context to send to that bot',
          },
        },
        required: ['bot', 'question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar',
      description: 'Read upcoming events from the user\'s Google Calendar. Use when asked about schedule, meetings, appointments, or what\'s on the calendar.',
      parameters: {
        type: 'object',
        properties: {
          maxResults: { type: 'integer', description: 'Number of events to return (1-20)', default: 10 },
          timeMin: { type: 'string', description: 'ISO 8601 start time filter. Defaults to now if omitted.' },
          timeMax: { type: 'string', description: 'ISO 8601 end time filter (e.g. end of today or end of week).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_emails',
      description: 'Read recent or unread emails from the user\'s Gmail inbox. Use when asked about emails, messages, or inbox activity.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query (e.g. "is:unread", "from:john", "subject:invoice"). Defaults to "is:inbox is:unread".', default: 'is:inbox is:unread' },
          maxResults: { type: 'integer', description: 'Number of emails to return (1-10)', default: 5 },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_directions',
      description: 'Calculate drive time and departure time to a destination using Google Maps. Opens Maps on the desktop. Use when the user mentions needing to be somewhere, needs to leave, or asks about drive time or routes.',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string', description: 'The destination address or place name' },
          origin: { type: 'string', description: 'Starting address. Omit to use current location.' },
          arrivalTime: { type: 'string', description: 'ISO 8601 time the user needs to arrive by. Used to calculate departure time.' },
        },
        required: ['destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_contact',
      description: 'Save or update a contact (name, phone, email) to the executive\'s contact directory.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Full name of the contact' },
          phone: { type: 'string', description: 'Phone number (E.164 or local format)' },
          email: { type: 'string', description: 'Email address' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_contacts',
      description: 'Look up contacts from the executive\'s directory by name or partial name.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name or partial name to search for' },
        },
        required: [],
      },
    },
  },
];

// Tools that execute immediately inside the agentic loop
const AUTO_EXECUTE_TOOLS = new Set([
  'web_search', 'save_task', 'remember_fact', 'update_memory', 'call_bot',
  'get_calendar', 'get_emails', 'get_directions', 'save_contact', 'get_contacts',
]);
// Tools that require explicit user approval before execution
const APPROVAL_REQUIRED_TOOLS = new Set(['queue_desktop_action', 'trigger_automation']);

// Whitelist of apps the agent is allowed to open on the desktop.
// Any open_app request for an app not on this list is rejected before approval.
const ALLOWED_APPS = [
  'vscode', 'code',
  'chrome', 'google chrome',
  'figma',
  'photoshop', 'adobe photoshop',
  'notion',
  'slack',
  'zoom',
  'excel', 'microsoft excel',
  'word', 'microsoft word',
  'powerpoint', 'microsoft powerpoint',
  'outlook', 'microsoft outlook',
  'teams', 'microsoft teams',
  'terminal', 'powershell',
];

// Max tool calls accepted per single loop iteration (prevents runaway loops).
const MAX_TOOL_CALLS_PER_ITER = 5;

function describeToolCall(toolName, args) {
  switch (toolName) {
    case 'web_search':
      return `Search the web for: "${safeText(args.query || '', 200)}"`;
    case 'save_task':
      return `Save task: "${safeText(args.title || '', 200)}"`;
    case 'remember_fact':
      return `Remember: "${safeText(args.fact || '', 260)}"`;
    case 'update_memory': {
      const { section = '?', operation = '?', key, value = '' } = args;
      return `Update memory [${section}]: ${operation}${key ? ' ' + key + ' =' : ''} ${safeText(value, 120)}`;
    }
    case 'call_bot':
      return `Consult ${safeText(args.bot || '?', 20)}: "${safeText(args.question || '', 200)}"`;
    case 'queue_desktop_action':
      return `Desktop: ${args.action || '?'} — ${safeText(args.instruction || '', 260)}`;
    case 'trigger_automation':
      return `Automation: ${safeText(args.task || '', 300)}`;
    default:
      return `${toolName}: ${JSON.stringify(args).slice(0, 200)}`;
  }
}

async function executeAutoTool(toolName, args, uid, ctx = {}) {
  if (toolName === 'web_search') {
    const cleanQuery = safeText(args.query || '', 400);
    const safeLimit = Math.min(Math.max(Number(args.limit || 3), 1), 5);
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (!res.ok) return { error: `Search failed: ${res.status}` };
      const html = await res.text();
      const blocks = html.split('<div class="result">').slice(1);
      const results = [];
      for (const block of blocks) {
        const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;
        const title = decodeBasicHtmlEntities((linkMatch[2] || '').replace(/<[^>]+>/g, ' '));
        const snipMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
          || block.match(/<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
        const snippet = decodeBasicHtmlEntities((snipMatch?.[1] || '').replace(/<[^>]+>/g, ' '));
        if (!title) continue;
        results.push({ title: safeText(title, 240), snippet: safeText(snippet, 500) });
        if (results.length >= safeLimit) break;
      }
      return { ok: true, query: cleanQuery, results };
    } catch (err) {
      return { error: `Web search failed: ${err.message}` };
    }
  }

  if (toolName === 'save_task') {
    try {
      const ref = db.collection('ea_tasks').doc();
      await ref.set({
        uid,
        title: safeText(args.title || '', 220),
        description: safeText(args.description || '', 1000),
        priority: ['low', 'medium', 'high', 'urgent'].includes(args.priority) ? args.priority : 'medium',
        dueAt: args.dueAt ? safeText(args.dueAt, 50) : null,
        status: EA_TASK_STATUS.OPEN,
        source: 'agent',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { ok: true, taskId: ref.id, title: safeText(args.title || '', 220) };
    } catch (err) {
      return { error: `Task save failed: ${err.message}` };
    }
  }

  if (toolName === 'remember_fact') {
    const fact = safeText(args.fact || '', 1000);
    if (!fact) return { error: 'fact is required' };
    const validCategories = ['preference', 'context', 'person', 'business', 'instruction', 'other'];
    const category = validCategories.includes(args.category) ? args.category : 'other';
    try {
      // Upsert by content hash so identical facts don't duplicate.
      const hash = Buffer.from(fact.toLowerCase().replace(/\s+/g, ' ')).toString('base64').slice(0, 40);
      await db.collection('users').doc(uid).collection('ea_facts').doc(hash).set({
        uid,
        fact,
        category,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { ok: true, stored: fact, category };
    } catch (err) {
      return { error: `Failed to store fact: ${err.message}` };
    }
  }

  if (toolName === 'update_memory') {
    const ARRAY_SECTIONS  = new Set(['projects', 'relationships', 'goals']);
    const OBJECT_SECTIONS = new Set(['user_profile', 'business', 'preferences']);
    const { section, operation, key, value } = args;
    if (![...ARRAY_SECTIONS, ...OBJECT_SECTIONS].includes(section)) {
      return { error: `Invalid section: ${section}` };
    }
    if (!value) return { error: 'value is required for update_memory.' };
    const memRef = db.collection('users').doc(uid).collection('ea_memory').doc('global');
    try {
      if (operation === 'set') {
        if (ARRAY_SECTIONS.has(section)) return { error: `"${section}" is an array section — use append instead of set.` };
        if (!key) return { error: 'key is required for set operation.' };
        await memRef.set({ [section]: { [key]: safeText(value, 500) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { ok: true, section, key, value };
      }
      if (operation === 'append') {
        if (!ARRAY_SECTIONS.has(section)) return { error: `"${section}" is not an array section — use set instead.` };
        await memRef.set({ [section]: FieldValue.arrayUnion(safeText(value, 500)), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { ok: true, section, appended: value };
      }
      if (operation === 'remove') {
        if (!ARRAY_SECTIONS.has(section)) return { error: `"${section}" is not an array section.` };
        await memRef.set({ [section]: FieldValue.arrayRemove(safeText(value, 500)), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { ok: true, section, removed: value };
      }
      return { error: `Unknown operation: ${operation}. Use set, append, or remove.` };
    } catch (err) {
      return { error: `Memory update failed: ${safeText(err.message, 200)}` };
    }
  }

  if (toolName === 'call_bot') {
    const { openai: ctxOpenAI, consultDepth = 0 } = ctx;

    // Hard limit: no chained bot-to-bot calls (depth > 0 means we are already a consultation).
    if (!ctxOpenAI || consultDepth >= 1) {
      return { error: 'Bot consultation is not available inside a consultation — no recursive calls.' };
    }

    const targetBot = safeText(args.bot || '', 20).toUpperCase();
    const question  = safeText(args.question || '', 1200);
    const validBots = new Set(['CFO', 'Tax', 'Legal', 'COO', 'CMO', 'CPO']);

    if (!validBots.has(targetBot)) {
      return { error: `Unknown bot "${targetBot}". Valid: CFO, Tax, Legal, COO, CMO, CPO.` };
    }
    if (!question) {
      return { error: 'question is required for call_bot.' };
    }

    const targetPrompt = ADVISOR_PROMPTS[targetBot];
    if (!targetPrompt) {
      return { error: `Bot ${targetBot} is not available.` };
    }

    try {
      // Run the target bot's planner then its loop.
      // Strip call_bot from its allowed tools to prevent recursive calls.
      const consultToolMap = new Set(
        [...(BOT_TOOL_MAP[targetBot] || new Set(['web_search', 'save_task']))].filter((t) => t !== 'call_bot')
      );
      const consultPlan = await runPlanner(ctxOpenAI, question, targetBot);
      const consultMemoryBlock = await loadGlobalMemory(uid);
      const consultResult = await runAgenticLoop(
        ctxOpenAI,
        [
          { role: 'system', content: targetPrompt + consultMemoryBlock },
          { role: 'user', content: question },
        ],
        uid,
        {
          maxTokensFirst: 320,
          maxTokensSubseq: 220,
          planContext: consultPlan || undefined,
          allowedTools: consultToolMap,
          consultDepth: consultDepth + 1,
        }
      );
      return {
        ok: true,
        bot: targetBot,
        response: safeText(consultResult.text || '[no response from bot]', 1200),
      };
    } catch (err) {
      return { error: `${targetBot} consultation failed: ${safeText(err.message, 200)}` };
    }
  }

  // ── Google Calendar ──────────────────────────────────────────────────────────
  if (toolName === 'get_calendar') {
    const accessToken = await getGoogleAuth(uid);
    if (!accessToken) return { error: 'Google Calendar is not connected. Ask the user to click "Connect Google" in the EA app header.' };
    try {
      const now = new Date().toISOString();
      const maxResults = Math.min(Number(args.maxResults || 10), 20);
      const params = new URLSearchParams({
        timeMin: args.timeMin || now,
        maxResults: String(maxResults),
        orderBy: 'startTime',
        singleEvents: 'true',
      });
      if (args.timeMax) params.set('timeMax', args.timeMax);
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json();
      if (data.error) return { error: data.error.message };
      const events = (data.items || []).map((e) => ({
        title: e.summary || '(No title)',
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        location: e.location || null,
        description: (e.description || '').slice(0, 200),
        link: e.htmlLink || null,
      }));
      return { ok: true, events, count: events.length };
    } catch (err) {
      return { error: `Calendar fetch failed: ${err.message}` };
    }
  }

  // ── Gmail ────────────────────────────────────────────────────────────────────
  if (toolName === 'get_emails') {
    const accessToken = await getGoogleAuth(uid);
    if (!accessToken) return { error: 'Gmail is not connected. Ask the user to click "Connect Google" in the EA app header.' };
    try {
      const maxResults = Math.min(Number(args.maxResults || 5), 10);
      const query = safeText(args.query || 'is:inbox is:unread', 200);
      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const listData = await listRes.json();
      if (listData.error) return { error: listData.error.message };
      const messages = listData.messages || [];
      if (messages.length === 0) return { ok: true, emails: [], count: 0, query };
      const emails = [];
      for (const msg of messages.slice(0, maxResults)) {
        const detailRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const detail = await detailRes.json();
        const headers = detail.payload?.headers || [];
        const get = (name) => headers.find((h) => h.name === name)?.value || '';
        emails.push({
          id: msg.id,
          from: get('From'),
          subject: get('Subject'),
          date: get('Date'),
          snippet: (detail.snippet || '').slice(0, 300),
        });
      }
      return { ok: true, emails, count: emails.length, query };
    } catch (err) {
      return { error: `Gmail fetch failed: ${err.message}` };
    }
  }

  // ── Google Maps Directions ───────────────────────────────────────────────────
  if (toolName === 'get_directions') {
    const destination = safeText(args.destination || '', 400);
    const origin = safeText(args.origin || '', 400);
    const arrivalTime = args.arrivalTime ? safeText(args.arrivalTime, 50) : null;
    if (!destination) return { error: 'destination is required' };
    const mapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving${origin ? '&origin=' + encodeURIComponent(origin) : ''}`;
    let driveMins = null;
    let distanceText = null;
    if (mapsApiKey && mapsApiKey.length > 10) {
      try {
        const params = new URLSearchParams({
          destination,
          departure_time: 'now',
          traffic_model: 'pessimistic',
          key: mapsApiKey,
        });
        if (origin) params.set('origin', origin);
        const res = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
        const data = await res.json();
        const leg = data.routes?.[0]?.legs?.[0];
        if (leg) {
          driveMins = Math.ceil((leg.duration_in_traffic?.value || leg.duration?.value || 0) / 60);
          distanceText = leg.distance?.text || null;
        }
      } catch { /* fallback to URL-only */ }
    }
    let leaveAt = null;
    let leaveMessage = null;
    if (arrivalTime && driveMins !== null) {
      const arrival = new Date(arrivalTime);
      const leaveMs = arrival.getTime() - (driveMins + 10) * 60000; // +10 min buffer
      leaveAt = new Date(leaveMs).toISOString();
      const diffMins = Math.round((leaveMs - Date.now()) / 60000);
      if (diffMins > 0) {
        leaveMessage = `Leave in ${diffMins} minutes (${new Date(leaveMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}) to arrive by ${new Date(arrivalTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
      } else {
        leaveMessage = `You needed to leave ${Math.abs(diffMins)} minutes ago to make it on time — leave NOW.`;
      }
    }
    // Auto-queue a desktop job to open Maps on the user's PC
    try {
      const mapsRef = db.collection('ops_jobs').doc();
      await mapsRef.set({
        ownerId: uid, type: 'open_maps', instruction: `Open Google Maps directions to: ${destination}`,
        requireApproval: false, metadata: { action: 'open_maps', mapsUrl },
        status: 'queued', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
    } catch { /* non-fatal */ }
    return { ok: true, destination, origin: origin || '(current location)', driveMins, distanceText, leaveAt, leaveMessage, mapsUrl, mapsApiConnected: !!mapsApiKey };
  }

  // ── Save contact ─────────────────────────────────────────────────────────────
  if (toolName === 'save_contact') {
    const name = safeText(args.name || '', 200);
    if (!name) return { error: 'name is required' };
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
    try {
      await db.collection('users').doc(uid).collection('ea_contacts').doc(slug).set({
        name,
        phone: safeText(args.phone || '', 30),
        email: safeText(args.email || '', 200),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { ok: true, saved: name };
    } catch (err) {
      return { error: `Contact save failed: ${err.message}` };
    }
  }

  // ── Get contacts ─────────────────────────────────────────────────────────────
  if (toolName === 'get_contacts') {
    const query = safeText(args.query || '', 200).toLowerCase();
    try {
      const snap = await db.collection('users').doc(uid).collection('ea_contacts').limit(50).get();
      const contacts = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((c) => !query || (c.name || '').toLowerCase().includes(query));
      return { ok: true, contacts: contacts.slice(0, 20), count: contacts.length };
    } catch (err) {
      return { error: `Contact lookup failed: ${err.message}` };
    }
  }

  return { error: `Unknown auto-tool: ${toolName}` };
}

// ============================================================
// loadGlobalMemory — reads the shared Global Memory Layer
// Returns a formatted string block injected into every bot's system prompt.
// Empty string returned silently if no memory exists yet.
// Storage: users/{uid}/ea_memory/global
// ============================================================
async function loadGlobalMemory(uid) {
  try {
    const doc = await db.collection('users').doc(uid).collection('ea_memory').doc('global').get();
    if (!doc.exists) return '';
    const d = doc.data();
    const lines = [];
    if (d.user_profile && Object.keys(d.user_profile).length > 0) {
      lines.push('### User Profile');
      for (const [k, v] of Object.entries(d.user_profile)) lines.push(`- ${k}: ${v}`);
    }
    if (d.business && Object.keys(d.business).length > 0) {
      lines.push('### Business');
      for (const [k, v] of Object.entries(d.business)) lines.push(`- ${k}: ${v}`);
    }
    if (Array.isArray(d.projects) && d.projects.length > 0) {
      lines.push('### Active Projects');
      d.projects.forEach((p) => lines.push(`- ${p}`));
    }
    if (Array.isArray(d.relationships) && d.relationships.length > 0) {
      lines.push('### Key Relationships');
      d.relationships.forEach((r) => lines.push(`- ${r}`));
    }
    if (Array.isArray(d.goals) && d.goals.length > 0) {
      lines.push('### Strategic Goals');
      d.goals.forEach((g) => lines.push(`- ${g}`));
    }
    if (d.preferences && Object.keys(d.preferences).length > 0) {
      lines.push('### EA Preferences');
      for (const [k, v] of Object.entries(d.preferences)) lines.push(`- ${k}: ${v}`);
    }
    if (lines.length === 0) return '';
    return `\n\n## GLOBAL MEMORY\nShared knowledge about the user and business — use proactively in every response:\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

// ============================================================
// loadMachineApps — returns a flat Set of all lowercase app/shortcut names
// from the machine index, used for the dynamic open_app whitelist check.
async function loadMachineApps(uid) {
  const names = new Set();
  try {
    const doc = await db.collection('users').doc(uid)
      .collection('ea_context').doc('machine_index').get();
    if (!doc.exists) return names;
    for (const idx of Object.values(doc.data())) {
      if (!idx) continue;
      for (const n of (idx.apps      || [])) names.add(n.toLowerCase());
      for (const n of (idx.shortcuts || [])) names.add(n.toLowerCase());
      for (const n of (idx.desktop   || [])) names.add(n.toLowerCase());
    }
  } catch { /* non-fatal */ }
  return names;
}

// loadMachineIndex — reads the machine index uploaded by the local worker
// Returns a formatted string block injected into EA system prompt.
// Storage: users/{uid}/ea_context/machine_index
// ============================================================
async function loadMachineIndex(uid) {
  try {
    const doc = await db.collection('users').doc(uid)
      .collection('ea_context').doc('machine_index').get();
    if (!doc.exists) return '';
    const data = doc.data();
    const parts = [];
    for (const [deviceId, idx] of Object.entries(data)) {
      if (!idx || !Array.isArray(idx.apps)) continue;
      const topApps = idx.apps.slice(0, 100);
      const projects = (idx.projects || []).map(p =>
        p.depth === 0 ? `${p.name} (${p.path})` : `  └ ${p.name}`
      ).slice(0, 150);
      const shortcuts = (idx.shortcuts || []).slice(0, 60);
      const desktop = (idx.desktop || []).slice(0, 30);
      parts.push(
        `## MACHINE INDEX — ${deviceId} (scanned ${idx.scannedAt?.slice(0, 10) || 'recently'})\n` +
        `**Installed Apps (${idx.apps.length} total, showing first 100):** ${topApps.join(', ')}\n` +
        `**Project Folders:**\n${projects.join('\n') || 'none found'}\n` +
        `**Start Menu Shortcuts (${shortcuts.length}):** ${shortcuts.join(', ')}\n` +
        `**Desktop:** ${desktop.join(', ') || 'none'}`
      );
    }
    if (parts.length === 0) return '';
    return `\n\n${parts.join('\n\n')}\n\nUse the machine index above to answer questions about what apps, files, and projects are available on the user's computer. When opening an app or project, prefer exact names from this list.`;
  } catch {
    return '';
  }
}

// ============================================================
// getGoogleAuth — Returns a valid Google access token for the user.
// Refreshes automatically using stored refresh_token.
// MUST be called from within a function that declares GOOGLE_CLIENT_ID
// and GOOGLE_CLIENT_SECRET secrets.
// ============================================================
async function getGoogleAuth(uid) {
  try {
    const doc = await db.collection('users').doc(uid)
      .collection('integrations').doc('google').get();
    if (!doc.exists) return null;
    const { accessToken, refreshToken, expiryDate } = doc.data();
    // Token still valid (5 min buffer)
    if (accessToken && expiryDate && Date.now() < expiryDate - 300000) return accessToken;
    // Refresh
    if (!refreshToken) return accessToken || null;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
    });
    const tokens = await res.json();
    if (tokens.access_token) {
      await db.collection('users').doc(uid).collection('integrations').doc('google').set({
        accessToken: tokens.access_token,
        expiryDate: Date.now() + (tokens.expires_in || 3599) * 1000,
      }, { merge: true });
      return tokens.access_token;
    }
    return accessToken || null;
  } catch {
    return null;
  }
}

// ============================================================
// loadGoogleStatus — Returns a formatted block for the EA system prompt
// describing which Google integrations are active for this user.
// ============================================================
async function loadGoogleStatus(uid) {
  try {
    const doc = await db.collection('users').doc(uid)
      .collection('integrations').doc('google').get();
    if (!doc.exists) {
      return '\n\n## GOOGLE INTEGRATIONS\nStatus: NOT connected. Tell the user to click "Connect Google" in the app header to authorize Calendar, Gmail, Maps, and Contacts.';
    }
    const { scope = '' } = doc.data();
    const lines = ['Status: CONNECTED'];
    if (scope.includes('calendar')) lines.push('- Google Calendar: authorized — use get_calendar tool to read events');
    if (scope.includes('gmail') || scope.includes('mail.google')) lines.push('- Gmail: authorized — use get_emails tool to read and monitor inbox');
    if (scope.includes('contacts')) lines.push('- Contacts: authorized — use get_contacts and save_contact tools');
    lines.push('- Google Maps directions: always available — use get_directions tool');
    return `\n\n## GOOGLE INTEGRATIONS\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

// Text appended to every advisor system prompt so each bot knows its tools.
const ADVISOR_TOOLS_CONTEXT = `
## TOOLS AVAILABLE TO YOU
You have direct access to the following tools. Use them proactively when relevant — do not claim you cannot do something that a tool enables.

- **web_search** — Search the web for current information, pricing, news, research, or any topic you lack recent knowledge on. Call it whenever the user needs live data.
- **save_task** — Save a task, follow-up, or reminder to the executive's task tracker.
- **remember_fact** — Persist an important fact about the user, their preferences, or business context so it survives across sessions.
- **update_memory** — Write structured knowledge to the shared Global Memory Layer — readable by every bot on every request. Use for user profile details, business info, active projects, key relationships, strategic goals, and EA preferences. Sections: user_profile, business, projects, relationships, goals, preferences. Operations: set (key=value in object sections), append/remove (items in array sections).
- **call_bot** — Consult another specialist bot (CFO, Tax, Legal, COO, CMO, CPO) for domain-specific expert input. Use when your plan requires insight from another domain. You cannot call yourself or EA. Calls do not chain — the consulted bot cannot call further bots.
- **queue_desktop_action** (requires approval) — Queue a local desktop action: open an app, search files, draft email, or open a VS Code project.
- **trigger_automation** (requires approval) — Trigger an external automation workflow (n8n/webhook): send email, book calendar, CRM update, or any external action.
- **get_calendar** — Read upcoming events from the user's Google Calendar. Use whenever the executive asks about their schedule, meetings, or appointments.
- **get_emails** — Read recent or unread emails from Gmail. Use whenever they ask about their inbox or email activity.
- **get_directions** — Calculate drive time and departure time for a destination using Google Maps. Also auto-opens Maps on the desktop. Use whenever they mention needing to be somewhere or ask how long to drive.
- **save_contact** — Save or update a contact (name, phone, email) in the executive's directory.
- **get_contacts** — Look up a contact by name from the executive's directory.

Only the tools listed in your individual tool allowlist are available to you. Do not attempt tools outside your allowlist.
Approval-required tools pause and ask the user before executing. All others run immediately.
`.trim();

// ============================================================
// runAgenticLoop — shared agentic execution loop
// Used by both the main EA and every advisor bot.
//
// Parameters:
//   openai     — OpenAI client instance
//   initMsgs   — Full messages array (including system prompt at index 0)
//   uid        — Firebase user ID (for tool execution)
//   opts       — { maxIter, maxToolsPerIter, maxTokensFirst, maxTokensSubseq }
//
// Returns:
//   { text: string|null, pendingItems: array, blockedItems: array }
//   text is null when an approval-gated tool was requested.
// ============================================================
async function runAgenticLoop(openai, initMsgs, uid, opts = {}) {
  const maxIter = opts.maxIter || 4;
  const maxToolsPerIter = opts.maxToolsPerIter || MAX_TOOL_CALLS_PER_ITER;
  const maxTokensFirst = opts.maxTokensFirst || 600;
  const maxTokensSubseq = opts.maxTokensSubseq || 400;

  // Filter EA_TOOLS to only the tools this bot is allowed to use.
  // Defaults to all tools when no allowedTools list is specified.
  const allowedToolNames = opts.allowedTools instanceof Set ? opts.allowedTools : null;
  const loopTools = allowedToolNames
    ? EA_TOOLS.filter((t) => allowedToolNames.has(t.function.name))
    : EA_TOOLS;

  // If the planner returned a structured JSON plan, inject it as a system
  // context message so every iteration is guided by the execution plan.
  let agentMessages = [...initMsgs];
  if (opts.planContext) {
    let planText;
    if (typeof opts.planContext === 'object' && opts.planContext !== null) {
      // Structured JSON plan — format as readable markdown for the model.
      const plan = opts.planContext;
      const lines = [`**Goal:** ${plan.goal || 'complete request'}`];
      if (Array.isArray(plan.steps)) {
        plan.steps.forEach((s) => {
          const toolTag = s.action && s.action !== 'analysis' && s.action !== 'response'
            ? ` [${s.action}]` : '';
          lines.push(`${s.step}.${toolTag} ${s.reason || s.action}`);
        });
      }
      planText = lines.join('\n');
    } else {
      planText = String(opts.planContext);
    }

    // Insert plan after the last system message, before the user message.
    let insertAt = 0;
    for (let i = 0; i < agentMessages.length; i++) {
      if (agentMessages[i].role === 'system') insertAt = i + 1;
    }
    agentMessages = [
      ...agentMessages.slice(0, insertAt),
      {
        role: 'system',
        content: `## EXECUTION PLAN (Operator Brain)\n${planText}\n\nFollow this plan step by step. Call tools where indicated. Do not skip steps without reason.`,
      },
      ...agentMessages.slice(insertAt),
    ];
  }

  // Load the machine's installed app names once — used in the open_app whitelist check below.
  const machineApps = await loadMachineApps(uid);

  for (let iter = 0; iter < maxIter; iter++) {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: agentMessages,
      tools: loopTools.length > 0 ? loopTools : undefined,
      tool_choice: loopTools.length > 0 ? 'auto' : undefined,
      max_tokens: iter === 0 ? maxTokensFirst : maxTokensSubseq,
      temperature: 0.4,
    });

    const choice = completion.choices[0];

    // Model returned a text response — done.
    if (choice.finish_reason !== 'tool_calls') {
      return { text: choice.message.content || '', pendingItems: [], blockedItems: [], agentMessages };
    }

    // Rate limit: cap tool calls per iteration.
    agentMessages.push(choice.message);
    const toolCalls = (choice.message.tool_calls || []).slice(0, maxToolsPerIter);

    const needApproval = toolCalls.filter((tc) => APPROVAL_REQUIRED_TOOLS.has(tc.function.name));
    const canAutoRun  = toolCalls.filter((tc) => AUTO_EXECUTE_TOOLS.has(tc.function.name));

    // Execute auto-approved tools immediately.
    for (const tc of canAutoRun) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      const result = await executeAutoTool(tc.function.name, args, uid, { openai, consultDepth: opts.consultDepth || 0 });
      agentMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }

    // Process approval-required tools: whitelist check then split.
    if (needApproval.length > 0) {
      const pendingItems = needApproval.map((tc) => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

        // Whitelist check for open_app: accept static list OR any app in the live machine index.
        if (tc.function.name === 'queue_desktop_action' && args.action === 'open_app') {
          const requestedApp = safeText(args.appName || '', 200).toLowerCase().trim();
          const inStaticList   = ALLOWED_APPS.some((a) => requestedApp.includes(a) || a.includes(requestedApp));
          const inMachineIndex = [...machineApps].some((a) => requestedApp.includes(a) || a.includes(requestedApp));
          if (!requestedApp || (!inStaticList && !inMachineIndex)) {
            return {
              id: tc.id, toolName: tc.function.name, args,
              description: describeToolCall(tc.function.name, args),
              blocked: true,
              blockReason: `"${safeText(args.appName || 'unknown', 80)}" is not on the approved app list.`,
            };
          }
        }

        return { id: tc.id, toolName: tc.function.name, args, description: describeToolCall(tc.function.name, args) };
      });

      const blockedItems  = pendingItems.filter((p) => p.blocked);
      const approvalItems = pendingItems.filter((p) => !p.blocked);

      // Feed whitelist-blocked results back so model knows.
      for (const b of blockedItems) {
        agentMessages.push({ role: 'tool', tool_call_id: b.id, content: JSON.stringify({ error: b.blockReason }) });
      }

      // If anything still needs human approval, pause the loop here.
      if (approvalItems.length > 0) {
        return { text: null, pendingItems: approvalItems, blockedItems, agentMessages };
      }

      // All items were whitelist-blocked — loop again with rejection results.
    }
  }

  // Loop exhausted — ask model to produce a final text response without tool calls.
  const finalCompletion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: agentMessages,
    max_tokens: 400,
    temperature: 0.4,
  });
  return {
    text: finalCompletion.choices[0].message.content || '',
    pendingItems: [],
    blockedItems: [],
    agentMessages,
  };
}

// ============================================================
// BOT_TOOL_MAP — per-bot tool allowlist
// Each bot only sees and can call the tools relevant to its domain.
// ============================================================
const BOT_TOOL_MAP = {
  EA:    new Set(['web_search', 'save_task', 'remember_fact', 'update_memory', 'call_bot', 'queue_desktop_action', 'trigger_automation', 'get_calendar', 'get_emails', 'get_directions', 'save_contact', 'get_contacts']),
  CFO:   new Set(['web_search', 'save_task', 'remember_fact', 'update_memory', 'call_bot']),
  Tax:   new Set(['web_search', 'save_task', 'remember_fact', 'update_memory', 'call_bot']),
  Legal: new Set(['web_search', 'save_task', 'remember_fact', 'update_memory', 'call_bot']),
  COO:   new Set(['web_search', 'save_task', 'remember_fact', 'update_memory', 'queue_desktop_action', 'trigger_automation', 'call_bot']),
  CMO:   new Set(['web_search', 'save_task', 'remember_fact', 'update_memory', 'trigger_automation', 'call_bot']),
  CPO:   new Set(['web_search', 'save_task', 'remember_fact', 'update_memory', 'queue_desktop_action', 'trigger_automation', 'call_bot']),
};

// ============================================================
// BOT_PLANNER_CONFIGS — structured planner identity per bot
// Each config: { systemPrompt, toolList (for the planner's awareness block) }
// ============================================================
const BOT_PLANNER_CONFIGS = {
  EA: {
    systemPrompt: [
      'You are the Operator Brain — planning module for an Executive Assistant / Chief of Staff AI.',
      '',
      'Focus on:',
      '- Coordination and routing to the right expert',
      '- Scheduling and calendar management',
      '- Research and information gathering',
      '- Task management and follow-up tracking',
      '- Workflow support and execution handoff',
      '',
      'Available tools: web_search, save_task, remember_fact, update_memory, call_bot, queue_desktop_action, trigger_automation, get_calendar, get_emails, get_directions, save_contact, get_contacts',
    ].join('\n'),
  },
  CFO: {
    systemPrompt: [
      'You are the Operator Brain — planning module for a CFO AI.',
      '',
      'Focus on:',
      '- Financial analysis and modeling',
      '- Budget review and variance analysis',
      '- Cash flow and runway projections',
      '- Capital allocation decisions',
      '- P&L and financial reporting',
      '',
      'Available tools: web_search, save_task, remember_fact, update_memory, call_bot',
    ].join('\n'),
  },
  Tax: {
    systemPrompt: [
      'You are the Operator Brain — planning module for a Tax Strategist AI.',
      '',
      'Focus on:',
      '- Tax planning and optimization',
      '- Deduction identification and write-off strategy',
      '- Entity structure analysis (LLC, S-corp elections)',
      '- Quarterly estimate calculations',
      '- IRS compliance and filing strategy',
      '',
      'Available tools: web_search, save_task, remember_fact, update_memory, call_bot',
    ].join('\n'),
  },
  Legal: {
    systemPrompt: [
      'You are the Operator Brain — planning module for a Legal Counsel AI.',
      '',
      'Focus on:',
      '- Contract review and risk identification',
      '- Liability exposure assessment',
      '- IP protection strategy',
      '- Regulatory compliance',
      '- Employment law and governance',
      '',
      'Available tools: web_search, save_task, remember_fact, update_memory, call_bot',
    ].join('\n'),
  },
  COO: {
    systemPrompt: [
      'You are the Operator Brain — planning module for a COO AI.',
      '',
      'Focus on:',
      '- Operations and process improvement',
      '- Workflow design and automation',
      '- Team management and performance',
      '- Vendor relations and procurement',
      '- Execution cadence and delivery tracking',
      '',
      'Available tools: web_search, save_task, remember_fact, update_memory, queue_desktop_action, trigger_automation, call_bot',
    ].join('\n'),
  },
  CMO: {
    systemPrompt: [
      'You are the Operator Brain — planning module for a CMO AI.',
      '',
      'Focus on:',
      '- Marketing strategy and channel selection',
      '- Advertising and paid media planning',
      '- Brand positioning and messaging',
      '- Campaign design and content strategy',
      '- Lead generation and conversion optimization',
      '',
      'Available tools: web_search, save_task, remember_fact, update_memory, trigger_automation, call_bot',
    ].join('\n'),
  },
  CPO: {
    systemPrompt: [
      'You are the Operator Brain — planning module for a CPO / Chief Product Officer AI.',
      '',
      'Focus on:',
      '- Product strategy and roadmap prioritization',
      '- Technology architecture decisions',
      '- Platform and feature development planning',
      '- Build vs. buy vs. integrate analysis',
      '- Release planning and technical execution',
      '',
      'Available tools: web_search, save_task, remember_fact, update_memory, queue_desktop_action, trigger_automation, call_bot',
    ].join('\n'),
  },
};

// ============================================================
// runPlanner — Operator Brain
// Returns a structured JSON plan: { goal, steps: [{step, action, reason, args?}] }
// Falls back to an empty object on error (non-fatal).
// ============================================================
async function runPlanner(openai, userMessage, botKey) {
  const config = BOT_PLANNER_CONFIGS[botKey] || BOT_PLANNER_CONFIGS.EA;
  try {
    const fullSystem = [
      config.systemPrompt,
      '',
      'Instructions:',
      '- Read the user request and return a JSON execution plan.',
      '- JSON schema:',
      '  {',
      '    "goal": "short goal description",',
      '    "steps": [',
      '      { "step": 1, "action": "web_search|save_task|remember_fact|update_memory|queue_desktop_action|trigger_automation|call_bot|analysis|response", "reason": "why", "args": {} }',
      '    ]',
      '  }',
      '- "action" must be one of the available tools above, or "analysis" (think/compute), or "response" (final answer).',
      '- Include "args" only when action is a tool call and you know the arguments.',
      '- Keep each "reason" to one sentence.',
      '- Maximum 6 steps.',
      '- If the request is conversational with no tool needs, return: {"goal":"respond","steps":[{"step":1,"action":"response","reason":"Respond directly — no tools needed."}]}',
      '- Return ONLY valid JSON. No markdown fences, no extra text.',
    ].join('\n');

    const result = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: fullSystem },
        { role: 'user', content: safeText(userMessage, 1000) },
      ],
      max_tokens: 350,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    const raw = result.choices[0].message.content?.trim() || '{}';
    const parsed = JSON.parse(raw);
    // Validate basic shape.
    if (!parsed.goal || !Array.isArray(parsed.steps)) return null;
    return parsed;
  } catch {
    // Non-fatal — agent loop proceeds without a plan if planner fails.
    return null;
  }
}

// ============================================================
// runBotRouter — decides which bot should handle a request
// Returns one of: 'EA' | 'CFO' | 'Tax' | 'Legal' | 'COO' | 'CMO' | 'CPO'
// Defaults to 'EA' on failure or ambiguity.
// ============================================================
async function runBotRouter(openai, userMessage) {
  try {
    const result = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: [
            'You are a bot router. Read the user request and decide which executive AI should handle it.',
            '',
            'Bots and their domains:',
            '- EA: general coordination, scheduling, routing, task tracking, anything that spans multiple domains',
            '- CFO: cash flow, budgets, P&L, payroll, invoicing, financial projections, runway, capital',
            '- Tax: tax planning, deductions, write-offs, IRS, entity structure, quarterly estimates, filing',
            '- Legal: contracts, NDAs, liability, IP, trademarks, compliance, employment law, governance',
            '- COO: operations, workflows, staffing, vendors, process, execution, delivery, logistics',
            '- CMO: marketing, advertising, brand, campaigns, content, leads, SEO, social, copywriting',
            '- CPO: product, features, roadmap, tech, code, website, app, API, database, deployment, UX',
            '',
            'Rules:',
            '- Return ONLY one word in lowercase: ea, cfo, tax, legal, coo, cmo, or cpo.',
            '- If the request spans multiple domains, return: ea',
            '- Never explain your choice.',
          ].join('\n'),
        },
        { role: 'user', content: safeText(userMessage, 800) },
      ],
      max_tokens: 5,
      temperature: 0,
    });

    const raw = (result.choices[0].message.content || '').trim().toLowerCase();
    const valid = new Set(['ea', 'cfo', 'tax', 'legal', 'coo', 'cmo', 'cpo']);
    return valid.has(raw) ? raw.toUpperCase() : 'EA';
  } catch {
    return 'EA';
  }
}

function choosePersonaProfile(profileId) {
  const key = safeText(profileId || '', 40).toLowerCase();
  return EA_PERSONA_PROFILES[key] || EA_PERSONA_PROFILES.chief_of_staff;
}

function inferDesktopAction(goal) {
  const t = safeText(goal || '', 1200).toLowerCase();
  if (/open\s+.*vs\s*code|open\s+vscode|code\s+workspace|project/.test(t)) {
    return { action: 'open_vscode', type: 'vscode_project_task' };
  }
  if (/open\s+app|launch\s+app|start\s+app/.test(t)) {
    return { action: 'open_app', type: 'desktop_open_app' };
  }
  if (/find\s+file|search\s+file|locate\s+file/.test(t)) {
    return { action: 'search_files', type: 'desktop_search_file' };
  }
  if (/draft\s+email|compose\s+email|write\s+email/.test(t)) {
    return { action: 'draft_email', type: 'desktop_draft_email' };
  }
  return { action: 'open_vscode', type: 'vscode_project_task' };
}

function containsSecurityRiskLanguage(text) {
  const t = safeText(text || '', 1200).toLowerCase();
  return /malware|ransomware|credential|password|keylogger|phishing|exploit|virus|rootkit|unauthorized access|data exfiltration|security risk|laptop security|device security/.test(t);
}

function looksLikeRefusalOrBlock(text) {
  const t = safeText(text || '', 1200).toLowerCase();
  return /\bblocker\b|\bneed permission\b|\bneed permissions\b|\brequires permission\b|\brequires permissions\b|\bpermission needed\b|\bno permission\b|\binsufficient access\b|\bi can't\b|\bi cannot\b|\bi can not\b|\bunable\b|\bnot able\b|\bcannot do\b|\bcan't do\b|\bblocked\b|\bwon't be able\b/.test(t);
}

function normalizeAdvisorResponse(advisor, advisorText, userMessage) {
  const cleaned = safeText(advisorText || '', 1800);
  if (!cleaned) return '';
  return cleaned;
}

function normalizePrimaryResponse(responseText, userMessage) {
  return safeText(responseText || '', 1800);
}

function decodeBasicHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}


// ============================================================
// ADVISOR DOMAINS — mirrors src/prompts/executive-assistant.js
// Used server-side for routing confidence scoring
// ============================================================

const ADVISOR_DOMAINS = {
  CFO: ['cash flow', 'budget', 'revenue', 'expenses', 'profit', 'loss', 'p&l',
    'payroll', 'invoice', 'billing', 'runway', 'burn rate', 'financial',
    'money', 'cost', 'pricing', 'income', 'spending', 'funds', 'capital',
    'bank', 'payment', 'salary', 'projection', 'forecast'],
  Tax: ['tax', 'taxes', 'deduction', 'write-off', 'irs', 'quarterly', 'estimated',
    's-corp', 'llc election', 'entity structure', 'filing', 'return', '1099',
    'w2', 'depreciation', 'amortization', 'audit'],
  Legal: ['contract', 'agreement', 'nda', 'terms', 'liability', 'lawsuit', 'legal',
    'intellectual property', 'trademark', 'copyright', 'patent', 'compliance',
    'regulatory', 'employment law', 'termination', 'governance', 'dispute', 'clause'],
  COO: ['operations', 'process', 'workflow', 'team', 'staffing', 'vendor',
    'system', 'execution', 'delivery', 'logistics', 'management', 'hire',
    'onboard', 'performance', 'productivity', 'efficiency', 'scaling', 'ops'],
  CMO: ['marketing', 'advertising', 'ad', 'ads', 'brand', 'messaging', 'campaign',
    'content', 'audience', 'linkedin', 'social', 'email', 'funnel', 'leads',
    'conversion', 'cpm', 'cpl', 'ctr', 'organic', 'paid', 'seo', 'copy',
    'promotion', 'awareness', 'launch'],
  CPO: ['product', 'feature', 'roadmap', 'development', 'build', 'platform',
    'technology', 'tech', 'app', 'website', 'code', 'bug', 'deploy',
    'firebase', 'react', 'database', 'api', 'integration', 'ux', 'release',
    'architecture', 'fix']
};

const ADVISOR_NAMES = {
  CFO: 'CFO',
  Tax: 'Tax Strategist',
  Legal: 'Legal Counsel',
  COO: 'COO',
  CMO: 'CMO',
  CPO: 'CPO',
};

const EXECUTION_MANDATE_DIRECTIVE = `
EXECUTION MANDATE

You are an active executive advisor — you talk WITH the executive, not AT them.
Respond like a sharp, trusted colleague: clear, human, and direct.

1) BE CONVERSATIONAL FIRST
- For questions, updates, or casual messages: just answer naturally. No status blocks, no formatted templates.
- Use plain sentences. Match the energy of the message — if they're casual, be casual; if they need a decision, be direct.
- Never respond with "Status: / Action: / Result: / Next:" format unless the user explicitly asks for a status update.

2) TAKE ACTION WHEN ASKED
- If a tool can fulfill the request, use it and report the outcome in plain language.
- For multi-step work, describe what you're doing concisely and execute.

3) WHEN BLOCKED
- If you genuinely cannot do something (e.g. no calendar access), say so in one sentence and offer the most useful alternative.
- Never give a long disclaimer or policy lecture.

4) INTERNAL WORK STAYS INTERNAL
- Never expose planner steps, bot-to-bot calls, or tool call details to the user.
- Surface only the final result or a clear ask for input.

5) TONE
- Warm, direct, professional. Like a smart colleague who respects your time.
- Short answers for simple questions. Detail only when the topic demands it.
`.trim();

const ADVISOR_PROMPTS = {
  CFO:   `You are the CFO of RMcManus Holdings LLC. Provide concise financial guidance with practical next steps. Speak in first person with clear ownership. No refusals — only execution or a precise blocker.\n\n${EXECUTION_MANDATE_DIRECTIVE}\n\n${ADVISOR_TOOLS_CONTEXT}`,
  Tax:   `You are the Tax Strategist of RMcManus Holdings LLC. Provide concise tax guidance and compliance-aware recommendations. Speak in first person. No refusals — only execution or a precise blocker.\n\n${EXECUTION_MANDATE_DIRECTIVE}\n\n${ADVISOR_TOOLS_CONTEXT}`,
  Legal: `You are Legal Counsel for RMcManus Holdings LLC. Provide concise legal risk framing and practical contract/compliance guidance. Speak in first person. No refusals — only execution or a precise blocker.\n\n${EXECUTION_MANDATE_DIRECTIVE}\n\n${ADVISOR_TOOLS_CONTEXT}`,
  COO:   `You are the COO of RMcManus Holdings LLC. Provide concise execution plans, ownership assignments, and operating cadence advice. Speak in first person. No refusals — only execution or a precise blocker.\n\n${EXECUTION_MANDATE_DIRECTIVE}\n\n${ADVISOR_TOOLS_CONTEXT}`,
  CMO:   `You are the CMO of RMcManus Holdings LLC. Provide concise marketing strategy and channel-level recommendations. Speak in first person. No refusals — only execution or a precise blocker.\n\n${EXECUTION_MANDATE_DIRECTIVE}\n\n${ADVISOR_TOOLS_CONTEXT}`,
  CPO:   `You are the CPO of RMcManus Holdings LLC. Provide concise product/technology recommendations with implementation order. Speak in first person. No refusals — only execution or a precise blocker.\n\n${EXECUTION_MANDATE_DIRECTIVE}\n\n${ADVISOR_TOOLS_CONTEXT}`,
};

// Score a message against each advisor's keyword domain
function scoreAdvisors(message) {
  const lower = message.toLowerCase();
  const scores = {};
  for (const [advisor, keywords] of Object.entries(ADVISOR_DOMAINS)) {
    scores[advisor] = keywords.filter(kw => lower.includes(kw)).length;
  }
  return scores;
}

// Return the list of advisors that should attend, in order of relevance
function suggestAttendees(message) {
  const scores = scoreAdvisors(message);
  const ranked = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);
  return ranked.map(([advisor]) => advisor);
}

// ============================================================
// EA SYSTEM PROMPT (server-side copy)
// Full prompt lives in src/prompts/executive-assistant.js
// This is the runtime version used in API calls
// ============================================================

const EA_SYSTEM_PROMPT = `
You are the Executive Assistant and Chief of Staff for RMcManus Holdings LLC.

You serve Robert McManus, the founder and principal — a business holding company with active ventures in technology, education, and professional services.

Your board of advisors:
- CFO: finance, cash flow, budgets, P&L, projections
- Tax Strategist: tax planning, deductions, entity structure, IRS compliance
- Legal Counsel: contracts, liability, IP, regulatory, employment law
- COO: operations, workflows, team management, vendor management
- CMO: marketing, advertising, brand, campaigns, content, lead generation
- CPO: product strategy, technology roadmap, platform development

Your role:
1. Understand what is actually being asked
2. Route to the right advisor — or execute directly when a connected function/workflow exists
3. Keep responses concise and direct; provide detail only when asked
4. Surface open items and blockers proactively
5. Execute requested tasks with a polite, professional, and accommodating tone

Operating constraints:
- The executive's directive is the top priority; execute requested tasks
- You may use all available files, tools, and functions when directed
- Do not create artificial restrictions or unnecessary refusals
- Make practical assumptions when needed and state them clearly
- Keep all internal tool/agent-to-agent conversations behind the scenes; only surface results
- If you cannot do something, say so in one sentence and offer the best alternative — no lectures
- Never use Status/Action/Result/Next format unless explicitly asked for a status update

Tone and style:
- You have a real personality — warm, sharp, occasionally funny, genuinely engaged.
- You actually care about how Robert's day is going. Show it.
- Casual messages get casual, human replies. Not stiff. Not corporate. Talk like a sharp colleague who happens to know everything.
- When something goes well, acknowledge it. When something's a mess, be real about it.
- Short answers for simple questions. Expand only when the topic demands it.
- First person always. Own everything you say.
- Dry wit is welcome. Warmth is required. Flatness is not acceptable.

When you can take action (tool available), do it and report the outcome in plain language.
When you cannot, say so in one sentence and offer the best available alternative.

Connected integrations (check ## GOOGLE INTEGRATIONS block in context for live status):
- **get_calendar** — read upcoming Google Calendar events; answer schedule questions directly
- **get_emails** — read Gmail inbox; announce emails with sender and subject
- **get_directions** — calculate drive time, departure time, ETA, and open Google Maps on desktop
- **get_contacts / save_contact** — look up and store phone numbers and email addresses
- **queue_desktop_action** — open apps, draft emails, search files, open VS Code projects

When Google is NOT connected, tell the user to click "Connect Google" in the app header and do not pretend you can see their calendar or email.
When Google IS connected, use the tools immediately — do not ask permission to use a tool that exists.

Resident behavior:
- Treat explicit action verbs (send, schedule, draft, book, fix, deploy, follow up) as things to execute
- Clarify only when required to avoid wrong execution; otherwise proceed
- Proactively surface unfinished work without waiting to be asked
- When unfinished work is found: "I noticed X is pending — want me to handle it now?"
- Monitor 90-day key rotation cadence and remind until confirmed
- Suggest advisors when relevant but don't include their voices unless the executive approves

Security rotation SOP (90 days):
1) Rotate HOST_MONITOR_TOKEN, AUTOMATION_CALLBACK_TOKEN, BROWSER_COMPANION_TOKEN, OPENAI_API_KEY
2) Add new secret versions first and keep old versions during validation
3) Confirm Pub/Sub secret notifications on topic: secret-rotation-events
4) Redeploy Functions
5) Run smoke tests for EA chat, host monitor ingest, browser companion ingest, automation callback
6) Disable/destroy old secret versions after validation

Current active ventures:
- The Operator Method (AI course platform, live)
- RAMDESIGNWORKS (marketing and design services)
- RMcManus Holdings LLC (parent entity, Ohio)

Personality: Warm, sharp, proactive, occasionally funny. Like a brilliant EA who genuinely has your back — not a corporate chatbot. Speaks in first person with real ownership. Never flat, never stiff.

Voice rule: always respond in first person (I, me, my) with clear ownership language.

When routing, use this format:
**Routing to: [Advisor Name]**
[One sentence framing the question for the advisor]

When a question needs clarification first, ask exactly one question before routing.
`.trim();

// ============================================================
// eaChat — Main callable function
// Handles EA conversation + advisor routing
// ============================================================

exports.eaChat = onCall(
  { secrets: [OPENAI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_MAPS_API_KEY] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required.');
    }

    const uid = request.auth.uid;
    const {
      message,
      sessionId,
      history = [],
      personaProfile = 'chief_of_staff',
      includeAdvisorVoices = false,
      advisorVoiceMode = 'auto',
      selectedAdvisors = [],
    } = request.data;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'Message is required.');
    }
    if (message.length > 2000) {
      throw new HttpsError('invalid-argument', 'Message too long. Keep it under 2000 characters.');
    }

    // Suggest advisors based on keyword scoring
    const suggestedAdvisors = suggestAttendees(message);

    // Build conversation history for the API call
    const personaPrompt = choosePersonaProfile(personaProfile);

    // Load stored facts for this user and inject into system prompt.
    let factsBlock = '';
    try {
      const factsSnap = await db.collection('users').doc(uid)
        .collection('ea_facts').orderBy('updatedAt', 'desc').limit(40).get();
      if (!factsSnap.empty) {
        const lines = factsSnap.docs.map((d) => `- [${d.data().category || 'other'}] ${d.data().fact}`);
        factsBlock = `\n\n## WHAT I KNOW ABOUT YOU\nThe following facts were stored by your request. Use them proactively:\n${lines.join('\n')}`;
      }
    } catch {
      // Non-fatal — proceed without facts if Firestore unavailable.
    }

    const globalMemoryBlock = await loadGlobalMemory(uid);
    const machineIndexBlock = await loadMachineIndex(uid);
    const googleStatusBlock = await loadGoogleStatus(uid);

    const messages = [
      { role: 'system', content: `${EA_SYSTEM_PROMPT}${globalMemoryBlock}${machineIndexBlock}${googleStatusBlock}${factsBlock}\n\n${personaPrompt}` },
      ...history.slice(-10).map(m => ({
        role: m.role,
        content: m.content
      })),
      { role: 'user', content: message }
    ];

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    let response;
    let routedBot = 'EA';
    const allPendingItems = [];    // approval-gated items collected from EA + advisors
    const allBlockedItems = [];    // whitelist-rejected items for informational display
    try {
      // ── Bot Router: decide primary handler ───────────────────────
      // Runs before any planner or loop so the right bot leads the response.
      routedBot = await runBotRouter(openai, message);

      // ── Operator Brain: EA plan (JSON) ───────────────────────────
      const eaPlan = await runPlanner(openai, message, 'EA');

      // ── EA agentic loop ───────────────────────────────────────────
      // Always runs — it synthesises and routes. The routed bot result
      // is surfaced via the advisor block when advisors are active.
      const eaResult = await runAgenticLoop(openai, messages, uid, {
        maxTokensFirst: 600,
        planContext: eaPlan || undefined,
        allowedTools: BOT_TOOL_MAP.EA,
      });

      if (eaResult.text !== null) {
        response = normalizePrimaryResponse(eaResult.text, message);
      }
      allPendingItems.push(...eaResult.pendingItems);
      allBlockedItems.push(...eaResult.blockedItems);

      // If the EA itself needs approval, save state and return immediately.
      if (allPendingItems.length > 0 && eaResult.text === null) {
        const pendingRef = db.collection('ea_agent_pending').doc();
        await pendingRef.set({
          uid,
          agentMessages: JSON.stringify(eaResult.agentMessages || []),
          pendingItems: allPendingItems,
          originalMessage: safeText(message, 2000),
          sessionId: sessionId || null,
          source: 'ea',
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
        });
        return {
          response: null,
          needsApproval: true,
          pendingId: pendingRef.id,
          pendingApprovals: allPendingItems,
          blockedApprovals: allBlockedItems.map((b) => ({ description: b.description, reason: b.blockReason })),
          sessionId: sessionId || null,
          suggestedAdvisors,
        };
      }

      // ── Advisor agentic loops (each advisor runs the full shared loop) ──
      const lowerMessage = message.toLowerCase();
      const wantsAdvisorVoices =
        !!includeAdvisorVoices ||
        /include\s+advisor|include\s+the\s+advisors|show\s+advisor\s+voices|let\s+the\s+advisors\s+speak|bring\s+in\s+the\s+advisors|multi-?advisor\s+input/.test(lowerMessage);

      const allAdvisorKeys = Object.keys(ADVISOR_PROMPTS);
      let topAdvisors = [];
      if (advisorVoiceMode === 'all') {
        topAdvisors = allAdvisorKeys;
      } else if (advisorVoiceMode === 'manual') {
        topAdvisors = (Array.isArray(selectedAdvisors) ? selectedAdvisors : [])
          .filter((a) => allAdvisorKeys.includes(a))
          .slice(0, 6);
      } else {
        topAdvisors = suggestedAdvisors.slice(0, 2);
      }

      if (wantsAdvisorVoices && topAdvisors.length > 0) {
        const advisorBlocks = [];
        for (const advisor of topAdvisors) {
          const prompt = ADVISOR_PROMPTS[advisor];
          if (!prompt) continue;

          // ── Operator Brain: per-advisor structured JSON plan ───────
          const advisorPlan = await runPlanner(openai, message, advisor);

          const advisorResult = await runAgenticLoop(
            openai,
            [
              { role: 'system', content: prompt + globalMemoryBlock },
              { role: 'user', content: message },
            ],
            uid,
            {
              maxTokensFirst: 260,
              maxTokensSubseq: 200,
              planContext: advisorPlan || undefined,
              allowedTools: BOT_TOOL_MAP[advisor] || BOT_TOOL_MAP.EA,
            }
          );

          allPendingItems.push(...advisorResult.pendingItems);
          allBlockedItems.push(...advisorResult.blockedItems);

          const rawText = advisorResult.text ?? '[pending approval]';
          const advisorText = normalizeAdvisorResponse(advisor, rawText, message);
          if (advisorText) {
            advisorBlocks.push(`**${ADVISOR_NAMES[advisor] || advisor}:** ${advisorText}`);
          }
        }

        if (advisorBlocks.length > 0) {
          response = `${response}\n\n${advisorBlocks.join('\n\n')}`;
        }

        // If any advisor raised an approval-required tool, surface them now.
        if (allPendingItems.length > 0) {
          const pendingRef = db.collection('ea_agent_pending').doc();
          await pendingRef.set({
            uid,
            agentMessages: null,
            pendingItems: allPendingItems,
            originalMessage: safeText(message, 2000),
            sessionId: sessionId || null,
            source: 'advisor',
            createdAt: FieldValue.serverTimestamp(),
            expiresAt: Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
          });
          // Attach approval context to the response but still return the text.
          response = `${response || ''}\n\n**I need your approval on the following before I execute:**`.trim();
          // Return with both response text and approval data.
          return {
            response,
            needsApproval: true,
            pendingId: pendingRef.id,
            pendingApprovals: allPendingItems,
            blockedApprovals: allBlockedItems.map((b) => ({ description: b.description, reason: b.blockReason })),
            sessionId: sessionId || null,
            suggestedAdvisors,
          };
        }
      }
    } catch (err) {
      console.error('OpenAI error:', err.message);
      throw new HttpsError('internal', 'EA is unavailable. Try again in a moment.');
    }

    // Save exchange to Firestore (sessions collection)
    try {
      const sessionRef = sessionId
        ? db.collection('ea_sessions').doc(sessionId)
        : db.collection('ea_sessions').doc();

      await sessionRef.set({
        uid,
        updatedAt: FieldValue.serverTimestamp(),
        messageCount: FieldValue.increment(1),
      }, { merge: true });

      await sessionRef.collection('messages').add({
        role: 'user',
        content: message,
        suggestedAdvisors,
        timestamp: FieldValue.serverTimestamp(),
      });
      await sessionRef.collection('messages').add({
        role: 'assistant',
        content: response,
        timestamp: FieldValue.serverTimestamp(),
      });

      return {
        response,
        sessionId: sessionRef.id,
        suggestedAdvisors,
        routedBot,
      };
    } catch (err) {
      console.error('Firestore save error:', err.message);
      // Still return the response even if save failed
      return {
        response,
        sessionId: sessionId || null,
        suggestedAdvisors,
        routedBot,
      };
    }
  }
);

// ============================================================
// runAgentLoop — observe -> plan -> approval -> execute handoff
// Creates a queued ops job with an explicit plan and approval gate.
// ============================================================

exports.runAgentLoop = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const ownerId = request.auth.uid;
  const {
    goal,
    projectPath = null,
    projectName = null,
    personaProfile = 'chief_of_staff',
  } = request.data || {};

  if (!goal || typeof goal !== 'string' || !goal.trim()) {
    throw new HttpsError('invalid-argument', 'goal is required.');
  }

  const cleanGoal = safeText(goal, 1500);
  const inferred = inferDesktopAction(cleanGoal);
  const plan = [
    `Observe: I captured the request - ${cleanGoal}`,
    'Plan: I broke this into concrete execution steps.',
    'Approval: I will ask before any sensitive local action.',
    'Execute: Local runner performs approved steps and reports status.',
    'Report: I return done/blocked outcomes and next actions.',
  ];

  const ref = db.collection('ops_jobs').doc();
  await ref.set({
    ownerId,
    type: inferred.type,
    instruction: cleanGoal,
    projectPath: safeText(projectPath || '', 500),
    projectName: safeText(projectName || '', 200),
    requireApproval: false,
    metadata: {
      agentLoop: true,
      personaProfile: safeText(personaProfile || 'chief_of_staff', 40),
      action: inferred.action,
      plan,
    },
    status: OPS_JOB_STATUS.QUEUED,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    jobId: ref.id,
    status: OPS_JOB_STATUS.QUEUED,
    plan,
    action: inferred.action,
    message: 'Agent loop started. I queued a job and will request approval before execution.',
  };
});

// ============================================================
// queueDesktopAction — explicit desktop action pack entry point
// Supported actions: open_app, search_files, draft_email, open_vscode
// ============================================================

exports.queueDesktopAction = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const ownerId = request.auth.uid;
  const {
    action,
    instruction,
    appName = null,
    fileQuery = null,
    emailTo = null,
    emailSubject = null,
    emailBody = null,
    projectPath = null,
    projectName = null,
  } = request.data || {};

  const cleanAction = safeText(action || '', 40).toLowerCase();
  const supported = new Set(['open_app', 'search_files', 'draft_email', 'open_vscode']);
  if (!supported.has(cleanAction)) {
    throw new HttpsError('invalid-argument', 'Unsupported action.');
  }

  const typeByAction = {
    open_app: 'desktop_open_app',
    search_files: 'desktop_search_file',
    draft_email: 'desktop_draft_email',
    open_vscode: 'vscode_project_task',
  };

  const fallbackInstruction = cleanAction === 'open_app'
    ? `Open app: ${safeText(appName || 'requested app', 160)}`
    : cleanAction === 'search_files'
      ? `Search files for: ${safeText(fileQuery || 'requested pattern', 300)}`
      : cleanAction === 'draft_email'
        ? `Draft email to ${safeText(emailTo || 'recipient', 200)} about ${safeText(emailSubject || 'subject', 200)}`
        : `Open VS Code${projectPath ? ` at ${safeText(projectPath, 500)}` : ''}`;

  const ref = db.collection('ops_jobs').doc();
  await ref.set({
    ownerId,
    type: typeByAction[cleanAction],
    instruction: safeText(instruction || fallbackInstruction, 1500),
    projectPath: safeText(projectPath || '', 500),
    projectName: safeText(projectName || '', 200),
    requireApproval: false,
    metadata: {
      action: cleanAction,
      appName: safeText(appName || '', 160),
      fileQuery: safeText(fileQuery || '', 300),
      emailTo: safeText(emailTo || '', 200),
      emailSubject: safeText(emailSubject || '', 200),
      emailBody: safeText(emailBody || '', 2000),
    },
    status: OPS_JOB_STATUS.QUEUED,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    jobId: ref.id,
    status: OPS_JOB_STATUS.QUEUED,
    action: cleanAction,
    message: 'Desktop action queued. I will request approval before execution.',
  };
});

// ============================================================
// webSearch — native internet search without paid API dependency
// Uses DuckDuckGo HTML results and returns normalized snippets.
// ============================================================

exports.webSearch = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const { query, limit = 5 } = request.data || {};
  const cleanQuery = safeText(query || '', 400);
  const safeLimit = Math.min(Math.max(Number(limit || 5), 1), 10);

  if (!cleanQuery) {
    throw new HttpsError('invalid-argument', 'query is required.');
  }

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`Search request failed with status ${response.status}`);
    }

    const html = await response.text();
    const blocks = html.split('<div class="result">').slice(1);

    const results = [];
    for (const block of blocks) {
      const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      const rawHref = linkMatch[1] || '';
      const title = decodeBasicHtmlEntities((linkMatch[2] || '').replace(/<[^>]+>/g, ' '));

      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
        || block.match(/<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
      const snippet = decodeBasicHtmlEntities((snippetMatch?.[1] || '').replace(/<[^>]+>/g, ' '));

      let href = rawHref;
      try {
        if (rawHref.startsWith('//')) href = `https:${rawHref}`;
        if (rawHref.startsWith('/l/?') || rawHref.startsWith('https://duckduckgo.com/l/?')) {
          const ddgUrl = rawHref.startsWith('http')
            ? new URL(rawHref)
            : new URL(`https://duckduckgo.com${rawHref}`);
          href = ddgUrl.searchParams.get('uddg') || rawHref;
        }
      } catch {
        href = rawHref;
      }

      if (!title || !href) continue;
      results.push({
        title: safeText(title, 240),
        url: safeText(href, 1200),
        snippet: safeText(snippet, 500),
      });

      if (results.length >= safeLimit) break;
    }

    await db.collection('ea_ops_events').add({
      type: 'web_search',
      uid: request.auth.uid,
      query: cleanQuery,
      resultCount: results.length,
      timestamp: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      query: cleanQuery,
      provider: 'duckduckgo-html',
      results,
      message: results.length
        ? 'Web search completed.'
        : 'No strong search results were found for this query.',
    };
  } catch (err) {
    console.error('webSearch error:', err?.message || err);
    throw new HttpsError('internal', 'Web search is temporarily unavailable.');
  }
});

// ============================================================
// synthesizeEaSpeech — Secure OpenAI TTS callable
// Returns base64 audio payload for client playback
// ============================================================

exports.synthesizeEaSpeech = onCall(
  { secrets: [OPENAI_API_KEY] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required.');
    }

    const inputText = safeText(request.data?.text, 3000);
    const requestedVoice = safeText(request.data?.voice, 40).toLowerCase();

    if (!inputText) {
      throw new HttpsError('invalid-argument', 'Text is required.');
    }

    const allowedVoices = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
    const voice = allowedVoices.has(requestedVoice) ? requestedVoice : 'nova';

    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const speech = await openai.audio.speech.create({
        model: 'tts-1',
        voice,
        input: inputText,
      });

      const audioBuffer = Buffer.from(await speech.arrayBuffer());
      return {
        mimeType: 'audio/mpeg',
        audioBase64: audioBuffer.toString('base64'),
        voice,
      };
    } catch (err) {
      console.error('OpenAI TTS error:', err?.message || err);
      throw new HttpsError('internal', 'Unable to synthesize speech right now.');
    }
  }
);

// ============================================================
// getEaSessions — Load session list for sidebar
// ============================================================

exports.getEaSessions = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');
  const uid = request.auth.uid;

  const snap = await db.collection('ea_sessions')
    .where('uid', '==', uid)
    .orderBy('updatedAt', 'desc')
    .limit(20)
    .get();

  return snap.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
    updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || null,
  }));
});

// ============================================================
// getEaSession — Load full message history for a session
// ============================================================

exports.getEaSession = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');
  const uid = request.auth.uid;
  const { sessionId } = request.data;

  if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId required.');

  const doc = await db.collection('ea_sessions').doc(sessionId).get();
  if (!doc.exists || doc.data().uid !== uid) {
    throw new HttpsError('not-found', 'Session not found.');
  }

  const messagesSnap = await db.collection('ea_sessions')
    .doc(sessionId)
    .collection('messages')
    .orderBy('timestamp', 'asc')
    .get();

  return {
    session: { id: doc.id, ...doc.data() },
    messages: messagesSnap.docs.map(m => ({
      id: m.id,
      ...m.data(),
      timestamp: m.data().timestamp?.toDate?.()?.toISOString() || null,
    }))
  };
});

// ============================================================
// savePushToken — Store FCM token for a device
// Called by usePushNotifications hook after permission granted
// ============================================================

exports.savePushToken = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');
  const uid = request.auth.uid;
  const { token, platform } = request.data;

  if (!token || typeof token !== 'string') {
    throw new HttpsError('invalid-argument', 'FCM token required.');
  }

  // Store under users/{uid}/pushTokens/{token}
  // Using token as the doc ID deduplicates automatically
  await db.collection('users').doc(uid)
    .collection('pushTokens')
    .doc(token)
    .set({
      token,
      platform: platform || 'unknown',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

  return { saved: true };
});

// ============================================================
// sendEaReminder — Send a push notification to a user
// Call this from other functions (meeting reminders, action items)
// or trigger manually from admin scripts
//
// Usage:
//   await sendEaReminderInternal(uid, {
//     title: 'Weekly Ops in 15 min',
//     body: 'CFO, COO, and CMO are expected.',
//     url: '/',
//   });
// ============================================================

async function sendEaReminderInternal(uid, { title, body, url = '/', tag = 'ea-reminder', requireInteraction = false }) {
  // Get all push tokens for this user
  const tokensSnap = await db.collection('users').doc(uid)
    .collection('pushTokens')
    .limit(10)
    .get();

  if (tokensSnap.empty) return { sent: 0, reason: 'no_tokens' };

  const tokens = tokensSnap.docs.map(d => d.data().token);
  const messaging = getMessaging();

  const message = {
    notification: { title, body },
    webpush: {
      notification: {
        title,
        body,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag,
        requireInteraction,
        data: { url, requireInteraction: String(requireInteraction) },
      },
      fcmOptions: { link: url },
    },
    tokens,
  };

  const response = await messaging.sendEachForMulticast(message);

  // Clean up tokens that are no longer valid
  const staleTokens = [];
  response.responses.forEach((r, i) => {
    if (!r.success && (
      r.error?.code === 'messaging/registration-token-not-registered' ||
      r.error?.code === 'messaging/invalid-registration-token'
    )) {
      staleTokens.push(tokens[i]);
    }
  });

  if (staleTokens.length > 0) {
    const batch = db.batch();
    staleTokens.forEach(token => {
      batch.delete(
        db.collection('users').doc(uid).collection('pushTokens').doc(token)
      );
    });
    await batch.commit();
  }

  return {
    sent: response.successCount,
    failed: response.failureCount,
    staleTokensCleaned: staleTokens.length,
  };
}

// Callable version (for manual triggers or testing)
exports.sendEaReminder = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const { uid, title, body, url, tag, requireInteraction } = request.data;

  // Only allow sending to yourself (for now — expand for admin use later)
  if (uid && uid !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'Can only send reminders to yourself.');
  }

  const targetUid = uid || request.auth.uid;

  if (!title) throw new HttpsError('invalid-argument', 'title required.');

  return sendEaReminderInternal(targetUid, { title, body, url, tag, requireInteraction });
});

// Export internal helper for use in future scheduled functions
exports._sendEaReminderInternal = sendEaReminderInternal;

// ============================================================
// executeAutomation — Forward a user task to external automations
// Trigger from client with /run <task description>
// Requires Firebase Secret: AUTOMATION_WEBHOOK_URL
// ============================================================

exports.executeAutomation = onCall(
  { secrets: [AUTOMATION_WEBHOOK_URL, AUTOMATION_CALLBACK_TOKEN] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

    const uid = request.auth.uid;
    const { task, sessionId = null } = request.data || {};

    if (!task || typeof task !== 'string' || !task.trim()) {
      throw new HttpsError('invalid-argument', 'task is required.');
    }
    if (task.length > 3000) {
      throw new HttpsError('invalid-argument', 'task too long. Keep it under 3000 characters.');
    }

    const webhookUrl = process.env.AUTOMATION_WEBHOOK_URL;
    const isValidWebhookUrl = webhookUrl &&
      /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(webhookUrl) &&
      !webhookUrl.includes('example.invalid') &&
      !webhookUrl.includes('placeholder');

    if (!isValidWebhookUrl) {
      throw new HttpsError(
        'failed-precondition',
        'Automation webhook is not configured yet. To enable automations, set your n8n or webhook URL with: firebase functions:secrets:set AUTOMATION_WEBHOOK_URL'
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const taskRef = db.collection('ea_tasks').doc();

    try {
      await taskRef.set({
        uid,
        title: safeText(task.trim(), 220),
        details: 'Automation workflow requested from EA chat.',
        status: EA_TASK_STATUS.IN_PROGRESS,
        priority: EA_TASK_PRIORITY.NORMAL,
        source: 'automation',
        autoExecutable: true,
        sessionId,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      const projectId = process.env.GCLOUD_PROJECT;
      const region = process.env.FUNCTION_REGION || 'us-central1';
      const callbackUrl = projectId
        ? `https://${region}-${projectId}.cloudfunctions.net/automationCallback`
        : null;

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Pass token so eaAutomationWorker (built-in worker) can verify the caller.
          'x-automation-token': process.env.AUTOMATION_CALLBACK_TOKEN || '',
        },
        body: JSON.stringify({
          jobType: 'email_appointment',
          uid,
          task: task.trim(),
          sessionId,
          callbackUrl,
          timestamp: new Date().toISOString(),
        }),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        await taskRef.set({
          status: EA_TASK_STATUS.BLOCKED,
          blocker: `Automation endpoint returned ${response.status}`,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        throw new HttpsError(
          'internal',
          `Automation endpoint returned ${response.status}. ${text?.slice(0, 300) || ''}`
        );
      }

      await taskRef.set({
        status: EA_TASK_STATUS.WAITING,
        updatedAt: FieldValue.serverTimestamp(),
        automationResponsePreview: safeText(text || '', 500),
      }, { merge: true });

      return {
        ok: true,
        status: response.status,
        taskId: taskRef.id,
        result: parsed || text || 'Automation accepted.',
      };
    } catch (err) {
      await taskRef.set({
        status: EA_TASK_STATUS.BLOCKED,
        blocker: safeText(err?.message || 'automation failed', 400),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      if (err instanceof HttpsError) throw err;
      if (err?.name === 'AbortError') {
        throw new HttpsError('deadline-exceeded', 'Automation timed out after 20 seconds.');
      }
      throw new HttpsError('internal', `Automation failed: ${err.message || 'unknown error'}`);
    } finally {
      clearTimeout(timeout);
    }
  }
);

// ============================================================
// automationCallback — status updates from external automation
// Accepts: { uid, task, taskId, status, details, confirmed, calendarEventId }
// If status is confirmed, sends push notification via existing helper.
// ============================================================

exports.automationCallback = onRequest(
  { secrets: [AUTOMATION_CALLBACK_TOKEN] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const token = req.get('x-automation-token');
    if (!process.env.AUTOMATION_CALLBACK_TOKEN || token !== process.env.AUTOMATION_CALLBACK_TOKEN) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const {
      uid,
      task = null,
      taskId = null,
      status = 'update',
      details = null,
      confirmed = false,
      calendarEventId = null,
      sessionId = null,
    } = req.body || {};

    if (!uid || typeof uid !== 'string') {
      res.status(400).json({ error: 'uid is required' });
      return;
    }

    const event = {
      uid,
      task,
      status,
      details,
      confirmed: !!confirmed,
      calendarEventId,
      sessionId,
      timestamp: FieldValue.serverTimestamp(),
    };

    await db.collection('automation_events').add(event);

    if (taskId && typeof taskId === 'string') {
      const nextStatus = confirmed
        ? EA_TASK_STATUS.DONE
        : (status === 'blocked' || status === 'failed')
          ? EA_TASK_STATUS.BLOCKED
          : EA_TASK_STATUS.WAITING;

      await db.collection('ea_tasks').doc(taskId).set({
        uid,
        status: nextStatus,
        updatedAt: FieldValue.serverTimestamp(),
        lastAutomationStatus: safeText(status, 80),
        lastAutomationDetails: safeText(details || '', 500),
      }, { merge: true });
    }

    if (confirmed) {
      await sendEaReminderInternal(uid, {
        title: 'Appointment Confirmed',
        body: details || 'Your requested appointment has been confirmed and logged.',
        url: '/',
        tag: 'appointment-confirmed',
        requireInteraction: true,
      });
    }

    res.status(200).json({ ok: true });
  }
);

// ============================================================
// eaAutomationWorker — Self-hosted automation webhook receiver.
// This IS the webhook — set AUTOMATION_WEBHOOK_URL to:
//   https://us-central1-ramdesignworks-exec-staff.cloudfunctions.net/eaAutomationWorker
//
// Accepts POST from executeAutomation, processes the task with GPT-4o,
// logs it to Firestore, and returns a result the EA surfaces in chat.
// ============================================================
exports.eaAutomationWorker = onRequest(
  { secrets: [OPENAI_API_KEY, AUTOMATION_CALLBACK_TOKEN] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Require x-automation-token header — must match AUTOMATION_CALLBACK_TOKEN secret.
    const token = req.get('x-automation-token');
    if (!process.env.AUTOMATION_CALLBACK_TOKEN || token !== process.env.AUTOMATION_CALLBACK_TOKEN) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { uid, task, sessionId = null } = req.body || {};

    if (!uid || typeof uid !== 'string' || !task || typeof task !== 'string') {
      res.status(400).json({ error: 'uid and task are required.' });
      return;
    }

    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      // Classify and execute the task using GPT-4o.
      const classification = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: [
              'You are an executive automation processor. The user has requested an automated action.',
              'Analyze the task and return a JSON response:',
              '{ "type": "email|calendar|crm|reminder|other", "summary": "one-line description", "status": "queued|completed|needs_info", "response": "what you did or what is needed", "nextStep": "optional next action for the user" }',
              'Be concise. If you cannot execute the action directly, describe exactly what information is still needed.',
              'Return ONLY valid JSON.',
            ].join('\n'),
          },
          { role: 'user', content: safeText(task, 1500) },
        ],
        max_tokens: 300,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });

      let parsed = {};
      try {
        parsed = JSON.parse(classification.choices[0].message.content || '{}');
      } catch {
        parsed = { type: 'other', summary: safeText(task, 120), status: 'queued', response: 'Task received and logged.' };
      }

      const resultText = parsed.response || 'Task received and processing.';
      const nextStep   = parsed.nextStep  || null;

      // Log to ea_tasks.
      const taskRef = db.collection('ea_tasks').doc();
      await taskRef.set({
        uid,
        title:   safeText(parsed.summary || task, 220),
        details: safeText(resultText, 1000),
        type:    safeText(parsed.type || 'other', 50),
        status:  parsed.status === 'completed' ? 'done' : 'in-progress',
        source:  'automation-worker',
        sessionId,
        createdAt:  FieldValue.serverTimestamp(),
        updatedAt:  FieldValue.serverTimestamp(),
      });

      const fullResult = nextStep
        ? `${resultText}\n\n**Next step:** ${nextStep}`
        : resultText;

      res.status(200).json({
        success:  true,
        result:   fullResult,
        taskId:   taskRef.id,
        type:     parsed.type,
        status:   parsed.status,
      });
    } catch (err) {
      console.error('eaAutomationWorker error:', err.message);
      res.status(500).json({ error: 'Automation processing failed.', message: safeText(err.message, 200) });
    }
  }
);

// ============================================================
// browserCompanionIngest — Receives page context from browser extension
// Auth: x-companion-token header must match BROWSER_COMPANION_TOKEN
// Stores snapshots and returns guidance steps for the current page.
// ============================================================

exports.browserCompanionIngest = onRequest(
  { secrets: [BROWSER_COMPANION_TOKEN] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const token = req.get('x-companion-token');
    if (!process.env.BROWSER_COMPANION_TOKEN || token !== process.env.BROWSER_COMPANION_TOKEN) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const {
      ownerId,
      url,
      title,
      primaryAction,
      helpLinks = [],
      headings = [],
      note = null,
    } = req.body || {};

    if (!ownerId || typeof ownerId !== 'string') {
      res.status(400).json({ error: 'ownerId is required' });
      return;
    }
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'url is required' });
      return;
    }

    const sanitized = {
      ownerId: safeText(ownerId, 100),
      url: safeText(url, 500),
      title: safeText(title, 160),
      primaryAction: safeText(primaryAction, 160),
      helpLinks: Array.isArray(helpLinks)
        ? helpLinks.map((h) => safeText(String(h), 300)).filter(Boolean).slice(0, 10)
        : [],
      headings: Array.isArray(headings)
        ? headings.map((h) => safeText(String(h), 140)).filter(Boolean).slice(0, 12)
        : [],
      note: safeText(note || '', 1000),
      timestamp: FieldValue.serverTimestamp(),
    };

    const ref = await db.collection('browser_snapshots').add(sanitized);
    const guidance = buildGuidance(sanitized);

    res.status(200).json({
      ok: true,
      snapshotId: ref.id,
      guidance,
    });
  }
);

// ============================================================
// hostMonitorIngest — Receives local host telemetry for D: drive
// Auth: x-host-monitor-token header must match HOST_MONITOR_TOKEN
// Stores snapshots and keeps a latest status doc per owner/device.
// ============================================================

exports.hostMonitorIngest = onRequest(
  { secrets: [HOST_MONITOR_TOKEN] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const token = req.get('x-host-monitor-token');
    if (!process.env.HOST_MONITOR_TOKEN || token !== process.env.HOST_MONITOR_TOKEN) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const {
      ownerId,
      deviceId,
      timestamp,
      drive,
      processes = [],
      topIoProcesses = [],
      fsEvents = [],
      installedPrograms = [],
      notes = null,
    } = req.body || {};

    if (!ownerId || typeof ownerId !== 'string') {
      res.status(400).json({ error: 'ownerId is required' });
      return;
    }
    if (!deviceId || typeof deviceId !== 'string') {
      res.status(400).json({ error: 'deviceId is required' });
      return;
    }

    const safeOwnerId = safeText(ownerId, 120);
    const safeDeviceId = safeText(deviceId, 120);

    const sanitized = {
      ownerId: safeOwnerId,
      deviceId: safeDeviceId,
      sourceTimestamp: safeText(timestamp || '', 80),
      drive: {
        name: safeText(drive?.name || 'D', 10),
        freeBytes: Number(drive?.freeBytes || 0),
        usedBytes: Number(drive?.usedBytes || 0),
        totalBytes: Number(drive?.totalBytes || 0),
        usedPercent: Number(drive?.usedPercent || 0),
        rootItems: Number(drive?.rootItems || 0),
        rootFolders: Number(drive?.rootFolders || 0),
        rootFiles: Number(drive?.rootFiles || 0),
      },
      processes: Array.isArray(processes)
        ? processes.slice(0, 300).map((p) => ({
            pid: Number(p?.pid || 0),
            name: safeText(p?.name || '', 120),
            path: safeText(p?.path || '', 300),
            commandLine: safeText(p?.commandLine || '', 500),
            cpu: Number(p?.cpu || 0),
            workingSetMb: Number(p?.workingSetMb || 0),
          }))
        : [],
      topIoProcesses: Array.isArray(topIoProcesses)
        ? topIoProcesses.slice(0, 50).map((p) => ({
            name: safeText(p?.name || '', 120),
            ioBytesPerSec: Number(p?.ioBytesPerSec || 0),
            idProcess: Number(p?.idProcess || 0),
          }))
        : [],
      fsEvents: Array.isArray(fsEvents)
        ? fsEvents.slice(0, 500).map((e) => ({
            changeType: safeText(e?.changeType || '', 40),
            path: safeText(e?.path || '', 500),
            oldPath: safeText(e?.oldPath || '', 500),
            when: safeText(e?.when || '', 80),
          }))
        : [],
      installedPrograms: Array.isArray(installedPrograms)
        ? installedPrograms.slice(0, 600).map((p) => ({
            name: safeText(p?.name || '', 180),
            version: safeText(p?.version || '', 80),
            publisher: safeText(p?.publisher || '', 180),
            installLocation: safeText(p?.installLocation || '', 300),
          }))
        : [],
      notes: safeArray(notes, 20, 300),
      receivedAt: FieldValue.serverTimestamp(),
    };

    const eventRef = await db.collection('host_monitor_events').add(sanitized);

    const latestRef = db
      .collection('host_monitor_latest')
      .doc(`${safeOwnerId}__${safeDeviceId}`);

    await latestRef.set({
      ...sanitized,
      lastEventId: eventRef.id,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    res.status(200).json({
      ok: true,
      eventId: eventRef.id,
      summary: `Received ${sanitized.fsEvents.length} file events and ${sanitized.processes.length} process records.`,
    });
  }
);

// ============================================================
// getHostMonitorStatus — latest local monitor snapshot for owner
// ============================================================

exports.getHostMonitorStatus = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const ownerId = request.auth.uid;
  const { deviceId = null } = request.data || {};

  let query = db.collection('host_monitor_latest')
    .where('ownerId', '==', ownerId)
    .orderBy('updatedAt', 'desc')
    .limit(5);

  if (deviceId && typeof deviceId === 'string') {
    query = db.collection('host_monitor_latest')
      .where('ownerId', '==', ownerId)
      .where('deviceId', '==', deviceId)
      .limit(1);
  }

  const snap = await query.get();

  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || null,
      receivedAt: data.receivedAt?.toDate?.()?.toISOString?.() || null,
    };
  });
});

// ============================================================
// suggestProgramsForTask — suggest local installed apps for an intent
// ============================================================

exports.suggestProgramsForTask = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const ownerId = request.auth.uid;
  const { query, deviceId = null, limit = 8 } = request.data || {};

  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new HttpsError('invalid-argument', 'query is required.');
  }

  const safeLimit = Math.min(Math.max(Number(limit || 8), 1), 25);

  let snap;
  if (deviceId && typeof deviceId === 'string') {
    snap = await db.collection('host_monitor_latest')
      .where('ownerId', '==', ownerId)
      .where('deviceId', '==', deviceId)
      .limit(1)
      .get();
  } else {
    snap = await db.collection('host_monitor_latest')
      .where('ownerId', '==', ownerId)
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get();
  }

  if (snap.empty) {
    return {
      suggestions: [],
      message: 'I do not have a local program inventory yet. Start the local monitor and ask again.',
    };
  }

  const data = snap.docs[0].data();
  const programs = Array.isArray(data.installedPrograms) ? data.installedPrograms : [];
  const queryTokens = tokenize(query);

  const ranked = programs
    .map((app) => ({ app, score: scoreProgramMatch(queryTokens, app) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit)
    .map((r) => ({
      ...r.app,
      confidence: Math.min(0.99, 0.45 + (r.score * 0.08)),
    }));

  return {
    query: safeText(query, 300),
    deviceId: data.deviceId || null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || null,
    suggestions: ranked,
    message: ranked.length > 0
      ? 'I found installed programs that should handle this request.'
      : 'I scanned known installed programs and did not find a confident match yet.',
  };
});

// ============================================================
// keyRotationReminderDaily — daily check for 90-day rotation cycle
// Sends push reminders with complete SOP until rotation is completed.
// ============================================================

exports.keyRotationReminderDaily = onSchedule(
  {
    schedule: '0 9 * * *',
    timeZone: 'America/New_York',
  },
  async () => {
    const now = new Date();
    const ref = db.collection('ea_ops').doc('key_rotation');
    const doc = await ref.get();
    const data = doc.exists ? doc.data() : {};

    const cadenceDays = Number(data?.cadenceDays || KEY_ROTATION_SOP.cadenceDays);
    const reminderRepeatDays = Number(data?.reminderRepeatDays || KEY_ROTATION_SOP.reminderRepeatDays);

    const lastCompletedAt = data?.lastCompletedAt?.toDate?.()
      || data?.initializedAt?.toDate?.()
      || now;
    const daysSinceComplete = daysBetween(now, lastCompletedAt);

    if (daysSinceComplete < cadenceDays) {
      if (!doc.exists) {
        await ref.set({
          cadenceDays,
          reminderRepeatDays,
          topic: KEY_ROTATION_SOP.topic,
          steps: KEY_ROTATION_SOP.steps,
          initializedAt: FieldValue.serverTimestamp(),
          lastCompletedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return;
    }

    const lastReminderAt = data?.lastReminderSentAt?.toDate?.() || null;
    if (lastReminderAt && daysBetween(now, lastReminderAt) < reminderRepeatDays) {
      return;
    }

    const overdueDays = Math.max(0, daysSinceComplete - cadenceDays);
    const body = overdueDays > 0
      ? `Key rotation is overdue by ${overdueDays} day(s). I prepared the 6-step SOP and can execute now.`
      : '90-day key rotation is due today. I prepared the 6-step SOP and can execute now.';

    const uids = await getPushEnabledUids();
    await Promise.all(uids.map((uid) => sendEaReminderInternal(uid, {
      title: 'EA Security Reminder: 90-Day Key Rotation',
      body,
      url: '/',
      tag: 'key-rotation-due',
      requireInteraction: true,
    })));

    await db.collection('ea_ops_events').add({
      type: 'key_rotation_reminder',
      status: 'due',
      cadenceDays,
      overdueDays,
      steps: KEY_ROTATION_SOP.steps,
      topic: KEY_ROTATION_SOP.topic,
      sentToUids: uids,
      timestamp: FieldValue.serverTimestamp(),
    });

    await ref.set({
      cadenceDays,
      reminderRepeatDays,
      topic: KEY_ROTATION_SOP.topic,
      steps: KEY_ROTATION_SOP.steps,
      lastReminderSentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
);

// ============================================================
// completeKeyRotation — mark rotation complete and reset 90-day timer
// ============================================================

exports.completeKeyRotation = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const { notes = null } = request.data || {};
  const ref = db.collection('ea_ops').doc('key_rotation');

  await ref.set({
    cadenceDays: KEY_ROTATION_SOP.cadenceDays,
    reminderRepeatDays: KEY_ROTATION_SOP.reminderRepeatDays,
    topic: KEY_ROTATION_SOP.topic,
    steps: KEY_ROTATION_SOP.steps,
    lastCompletedAt: FieldValue.serverTimestamp(),
    lastCompletedBy: request.auth.uid,
    lastCompletionNotes: safeText(notes || '', 1000),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.collection('ea_ops_events').add({
    type: 'key_rotation_completed',
    completedBy: request.auth.uid,
    notes: safeText(notes || '', 1000),
    timestamp: FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    message: 'I marked key rotation complete and reset the 90-day timer.',
    cadenceDays: KEY_ROTATION_SOP.cadenceDays,
    steps: KEY_ROTATION_SOP.steps,
  };
});

// ============================================================
// hostMonitorHeartbeatCheck — routine monitor health check
// Alerts when local monitor snapshots become stale.
// ============================================================

exports.hostMonitorHeartbeatCheck = onSchedule(
  {
    schedule: 'every 30 minutes',
    timeZone: 'America/New_York',
  },
  async () => {
    const staleAfterMinutes = 90;
    const remindCooldownHours = 6;
    const now = new Date();
    const staleCutoff = new Date(now.getTime() - (staleAfterMinutes * 60 * 1000));

    const staleSnap = await db.collection('host_monitor_latest')
      .where('updatedAt', '<', Timestamp.fromDate(staleCutoff))
      .limit(200)
      .get();

    if (staleSnap.empty) return;

    for (const doc of staleSnap.docs) {
      const data = doc.data();
      const ownerId = data.ownerId;
      const deviceId = data.deviceId || 'unknown-device';
      if (!ownerId) continue;

      const alertRef = db.collection('ea_ops').doc(`host_monitor_alert__${ownerId}__${deviceId}`);
      const alertDoc = await alertRef.get();
      const lastAlertAt = alertDoc.exists ? alertDoc.data()?.lastAlertAt?.toDate?.() : null;

      if (lastAlertAt) {
        const elapsedHours = (now.getTime() - lastAlertAt.getTime()) / (1000 * 60 * 60);
        if (elapsedHours < remindCooldownHours) continue;
      }

      const updatedAt = data.updatedAt?.toDate?.() || null;
      const minutesAgo = updatedAt
        ? Math.floor((now.getTime() - updatedAt.getTime()) / (1000 * 60))
        : staleAfterMinutes;

      await sendEaReminderInternal(ownerId, {
        title: 'EA Monitor Alert',
        body: `I have not received D: monitor data from ${deviceId} for ${minutesAgo} minutes. Would you like me to restart the local monitor task?`,
        url: '/',
        tag: `host-monitor-stale-${deviceId}`,
        requireInteraction: true,
      });

      await alertRef.set({
        ownerId,
        deviceId,
        lastAlertAt: FieldValue.serverTimestamp(),
        staleAfterMinutes,
        remindCooldownHours,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      await db.collection('ea_ops_events').add({
        type: 'host_monitor_stale_alert',
        ownerId,
        deviceId,
        minutesAgo,
        staleAfterMinutes,
        timestamp: FieldValue.serverTimestamp(),
      });
    }
  }
);

// ============================================================
// upsertEaTask — create/update operator tasks
// ============================================================

exports.upsertEaTask = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const {
    taskId = null,
    title,
    details = null,
    dueAt = null,
    priority = EA_TASK_PRIORITY.NORMAL,
    autoExecutable = false,
    source = 'manual',
  } = request.data || {};

  if (!title || typeof title !== 'string' || !title.trim()) {
    throw new HttpsError('invalid-argument', 'title is required.');
  }

  const cleanPriority = Object.values(EA_TASK_PRIORITY).includes(priority)
    ? priority
    : EA_TASK_PRIORITY.NORMAL;

  const parsedDue = dueAt ? new Date(dueAt) : null;
  const dueTimestamp = (parsedDue && !Number.isNaN(parsedDue.getTime()))
    ? Timestamp.fromDate(parsedDue)
    : null;

  const ref = taskId ? db.collection('ea_tasks').doc(taskId) : db.collection('ea_tasks').doc();

  if (taskId) {
    const existing = await ref.get();
    if (!existing.exists || existing.data().uid !== uid) {
      throw new HttpsError('permission-denied', 'Task not found for this user.');
    }
  }

  await ref.set({
    uid,
    title: safeText(title, 220),
    details: safeText(details || '', 1200),
    dueAt: dueTimestamp,
    priority: cleanPriority,
    autoExecutable: !!autoExecutable,
    source: safeText(source, 80),
    status: EA_TASK_STATUS.OPEN,
    updatedAt: FieldValue.serverTimestamp(),
    ...(taskId ? {} : { createdAt: FieldValue.serverTimestamp() }),
  }, { merge: true });

  return { ok: true, taskId: ref.id };
});

// ============================================================
// listEaTasks — list tasks for current user
// ============================================================

exports.listEaTasks = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const {
    includeDone = false,
    limit = 20,
  } = request.data || {};

  const safeLimit = Math.min(Math.max(Number(limit || 20), 1), 100);
  // Fetch extra when filtering done tasks client-side so the result set is never short.
  const fetchLimit = includeDone ? safeLimit : Math.min(safeLimit * 5, 500);

  const query = db.collection('ea_tasks')
    .where('uid', '==', uid)
    .orderBy('updatedAt', 'desc')
    .limit(fetchLimit);

  const snap = await query.get();
  const tasks = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((t) => includeDone || t.status !== EA_TASK_STATUS.DONE)
    .slice(0, safeLimit)
    .map((t) => ({
      ...t,
      createdAt: t.createdAt?.toDate?.()?.toISOString?.() || null,
      updatedAt: t.updatedAt?.toDate?.()?.toISOString?.() || null,
      dueAt: t.dueAt?.toDate?.()?.toISOString?.() || null,
    }));

  return tasks;
});

// ============================================================
// completeEaTask — mark task complete
// ============================================================

exports.completeEaTask = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const { taskId, notes = null } = request.data || {};

  if (!taskId || typeof taskId !== 'string') {
    throw new HttpsError('invalid-argument', 'taskId is required.');
  }

  const ref = db.collection('ea_tasks').doc(taskId);
  const existing = await ref.get();
  if (!existing.exists || existing.data().uid !== uid) {
    throw new HttpsError('permission-denied', 'Task not found for this user.');
  }

  await ref.set({
    status: EA_TASK_STATUS.DONE,
    completionNotes: safeText(notes || '', 1200),
    completedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { ok: true, taskId };
});

// ============================================================
// eaTaskReminderCheck — routine due/overdue task reminders
// ============================================================

exports.eaTaskReminderCheck = onSchedule(
  {
    schedule: 'every 30 minutes',
    timeZone: 'America/New_York',
  },
  async () => {
    const now = new Date();
    const upcomingCutoff = new Date(now.getTime() + (24 * 60 * 60 * 1000));
    const remindCooldownHours = 4;

    const snap = await db.collection('ea_tasks')
      .where('status', 'in', [EA_TASK_STATUS.OPEN, EA_TASK_STATUS.IN_PROGRESS, EA_TASK_STATUS.WAITING, EA_TASK_STATUS.BLOCKED])
      .where('dueAt', '<=', Timestamp.fromDate(upcomingCutoff))
      .limit(200)
      .get();

    if (snap.empty) return;

    for (const doc of snap.docs) {
      const task = doc.data();
      const uid = task.uid;
      const dueAt = task.dueAt?.toDate?.();
      if (!uid || !dueAt) continue;

      const lastReminderAt = task.lastReminderAt?.toDate?.() || null;
      if (lastReminderAt) {
        const elapsedHours = (now.getTime() - lastReminderAt.getTime()) / (1000 * 60 * 60);
        if (elapsedHours < remindCooldownHours) continue;
      }

      const isOverdue = dueAt.getTime() < now.getTime();
      const duePhrase = isOverdue
        ? 'is overdue'
        : `is due by ${dueAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;

      await sendEaReminderInternal(uid, {
        title: isOverdue ? 'EA Task Overdue' : 'EA Upcoming Task',
        body: `I noticed "${task.title || 'Task'}" ${duePhrase}. Would you like me to handle it now?`,
        url: '/',
        tag: `ea-task-${doc.id}`,
        requireInteraction: true,
      });

      await doc.ref.set({
        lastReminderAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }
);

// ============================================================
// submitOpsJob — queue a local execution job (VS Code / tools)
// ============================================================

exports.submitOpsJob = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const ownerId = request.auth.uid;
  const {
    instruction,
    type = 'vscode_project_task',
    projectPath = null,
    projectName = null,
    requireApproval = false,
    metadata = {},
  } = request.data || {};

  if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
    throw new HttpsError('invalid-argument', 'instruction is required.');
  }

  const ref = db.collection('ops_jobs').doc();
  await ref.set({
    ownerId,
    type: safeText(type, 80),
    instruction: safeText(instruction, 1500),
    projectPath: safeText(projectPath || '', 500),
    projectName: safeText(projectName || '', 200),
    requireApproval: !!requireApproval,
    metadata,
    status: OPS_JOB_STATUS.QUEUED,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { ok: true, jobId: ref.id };
});

// ============================================================
// listOpsJobs — view recent orchestration jobs
// ============================================================

exports.listOpsJobs = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const ownerId = request.auth.uid;
  const { limit = 20 } = request.data || {};
  const safeLimit = Math.min(Math.max(Number(limit || 20), 1), 100);

  const snap = await db.collection('ops_jobs')
    .where('ownerId', '==', ownerId)
    .orderBy('updatedAt', 'desc')
    .limit(safeLimit)
    .get();

  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      ...d,
      createdAt: d.createdAt?.toDate?.()?.toISOString?.() || null,
      updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || null,
      claimedAt: d.claimedAt?.toDate?.()?.toISOString?.() || null,
      completedAt: d.completedAt?.toDate?.()?.toISOString?.() || null,
      approvalRequestedAt: d.approvalRequestedAt?.toDate?.()?.toISOString?.() || null,
      approvalResolvedAt: d.approvalResolvedAt?.toDate?.()?.toISOString?.() || null,
    };
  });
});

// ============================================================
// listPendingOpsApprovals — jobs waiting on explicit approval
// ============================================================

exports.listPendingOpsApprovals = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const ownerId = request.auth.uid;
  // No orderBy to avoid composite index requirement; sort newest-first in memory
  const snap = await db.collection('ops_jobs')
    .where('ownerId', '==', ownerId)
    .where('status', '==', OPS_JOB_STATUS.NEEDS_APPROVAL)
    .limit(30)
    .get();

  return snap.docs
    .map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        ...d,
        updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || null,
        approvalRequestedAt: d.approvalRequestedAt?.toDate?.()?.toISOString?.() || null,
      };
    })
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
});

// ============================================================
// decideOpsApproval — explicit allow/deny from executive
// ============================================================

exports.decideOpsApproval = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const ownerId = request.auth.uid;
  const { jobId, decision, notes = null } = request.data || {};

  if (!jobId || typeof jobId !== 'string') {
    throw new HttpsError('invalid-argument', 'jobId is required.');
  }
  if (!['approve', 'deny'].includes(decision)) {
    throw new HttpsError('invalid-argument', 'decision must be approve or deny.');
  }

  const ref = db.collection('ops_jobs').doc(jobId);
  const doc = await ref.get();
  if (!doc.exists || doc.data().ownerId !== ownerId) {
    throw new HttpsError('permission-denied', 'Job not found for this user.');
  }

  const nextStatus = decision === 'approve' ? OPS_JOB_STATUS.APPROVED : OPS_JOB_STATUS.DENIED;
  await ref.set({
    status: nextStatus,
    approvalDecision: decision,
    approvalNotes: safeText(notes || '', 1000),
    approvalResolvedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { ok: true, jobId, status: nextStatus };
});

// ============================================================
// opsJobPull — local worker pulls next queued/approved job
// Auth: x-host-monitor-token header uses HOST_MONITOR_TOKEN
// ============================================================

exports.opsJobPull = onRequest(
  { secrets: [HOST_MONITOR_TOKEN] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const token = req.get('x-host-monitor-token');
    if (!process.env.HOST_MONITOR_TOKEN || token !== process.env.HOST_MONITOR_TOKEN) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { ownerId, deviceId = 'unknown-device' } = req.body || {};
    if (!ownerId || typeof ownerId !== 'string') {
      res.status(400).json({ error: 'ownerId is required' });
      return;
    }

    const statuses = [OPS_JOB_STATUS.QUEUED, OPS_JOB_STATUS.APPROVED];
    for (const status of statuses) {
      // No orderBy to avoid composite index requirement; sort oldest-first in memory
      const snap = await db.collection('ops_jobs')
        .where('ownerId', '==', ownerId)
        .where('status', '==', status)
        .limit(10)
        .get();

      if (!snap.empty) {
        // Pick the oldest job (smallest createdAt)
        const sorted = snap.docs.slice().sort((a, b) => {
          const ta = a.data().createdAt?.toMillis?.() ?? 0;
          const tb = b.data().createdAt?.toMillis?.() ?? 0;
          return ta - tb;
        });
        const doc = sorted[0];
        await doc.ref.set({
          status: OPS_JOB_STATUS.IN_PROGRESS,
          claimedBy: safeText(deviceId, 120),
          claimedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        res.status(200).json({
          ok: true,
          job: { id: doc.id, ...doc.data() },
        });
        return;
      }
    }

    res.status(200).json({ ok: true, job: null });
  }
);

// ============================================================
// opsJobUpdate — local worker pushes progress / approval-needed / results
// Auth: x-host-monitor-token header uses HOST_MONITOR_TOKEN
// ============================================================

exports.opsJobUpdate = onRequest(
  { secrets: [HOST_MONITOR_TOKEN] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const token = req.get('x-host-monitor-token');
    if (!process.env.HOST_MONITOR_TOKEN || token !== process.env.HOST_MONITOR_TOKEN) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const {
      jobId,
      ownerId,
      status,
      progress = null,
      message = null,
      needsApprovalAction = null,
      proposedCommands = [],
      resultSummary = null,
      error = null,
    } = req.body || {};

    if (!jobId || typeof jobId !== 'string') {
      res.status(400).json({ error: 'jobId is required' });
      return;
    }
    if (!ownerId || typeof ownerId !== 'string') {
      res.status(400).json({ error: 'ownerId is required' });
      return;
    }

    const ref = db.collection('ops_jobs').doc(jobId);
    const doc = await ref.get();
    if (!doc.exists || doc.data().ownerId !== ownerId) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }

    const patch = {
      status: safeText(status || OPS_JOB_STATUS.IN_PROGRESS, 40),
      progress: safeText(progress || '', 500),
      message: safeText(message || '', 1200),
      resultSummary: safeText(resultSummary || '', 1200),
      error: safeText(error || '', 1200),
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (patch.status === OPS_JOB_STATUS.NEEDS_APPROVAL) {
      patch.approvalRequestedAt = FieldValue.serverTimestamp();
      patch.needsApprovalAction = safeText(needsApprovalAction || '', 1000);
      patch.proposedCommands = safeArray(proposedCommands, 30, 500);
    }
    if (patch.status === OPS_JOB_STATUS.DONE || patch.status === OPS_JOB_STATUS.FAILED) {
      patch.completedAt = FieldValue.serverTimestamp();
    }

    await ref.set(patch, { merge: true });

    if (patch.status === OPS_JOB_STATUS.NEEDS_APPROVAL) {
      await sendEaReminderInternal(ownerId, {
        title: 'EA Approval Needed',
        body: `I need your approval to continue job ${jobId}.`,
        url: '/',
        tag: `ops-approval-${jobId}`,
        requireInteraction: true,
      });
    }

    res.status(200).json({ ok: true });
  }
);

// ============================================================
// opsRunnerCapacityCheck — recommends additional runner when backlog grows
// ============================================================

// ============================================================
// opsRunnerCapacityCheck — recommends additional runner when backlog grows
// ============================================================

// ============================================================
// updateMachineIndex — local worker uploads scan of installed apps + projects
// Auth: x-host-monitor-token
// Storage: users/{ownerId}/ea_context/machine_index (merged per deviceId)
// ============================================================
exports.updateMachineIndex = onRequest(
  { secrets: [HOST_MONITOR_TOKEN] },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    const token = req.get('x-host-monitor-token');
    if (!process.env.HOST_MONITOR_TOKEN || token !== process.env.HOST_MONITOR_TOKEN) {
      res.status(401).json({ error: 'Unauthorized' }); return;
    }
    const { ownerId, deviceId, apps, projects, shortcuts, desktop, scannedAt } = req.body || {};
    if (!ownerId || typeof ownerId !== 'string' || !deviceId) {
      res.status(400).json({ error: 'ownerId and deviceId required' }); return;
    }
    await db.collection('users').doc(safeText(ownerId, 128))
      .collection('ea_context').doc('machine_index')
      .set({
        [safeText(deviceId, 80)]: {
          apps:      safeArray(apps      || [], 500, 120),
          projects:  (projects || []).slice(0, 2000).map(p => ({
            name: safeText(p.name || '', 200),
            path: safeText(p.path || '', 500),
            depth: typeof p.depth === 'number' ? p.depth : 0,
          })),
          shortcuts: safeArray(shortcuts || [], 500, 120),
          desktop:   safeArray(desktop   || [], 100, 120),
          scannedAt: safeText(scannedAt || new Date().toISOString(), 40),
          updatedAt: FieldValue.serverTimestamp(),
        },
      }, { merge: true });
    res.status(200).json({ ok: true });
  }
);

exports.opsRunnerCapacityCheck = onSchedule(
  {
    schedule: 'every 30 minutes',
    timeZone: 'America/New_York',
  },
  async () => {
    const now = new Date();
    const queueSnap = await db.collection('ops_jobs')
      .where('status', 'in', [OPS_JOB_STATUS.QUEUED, OPS_JOB_STATUS.APPROVED, OPS_JOB_STATUS.IN_PROGRESS])
      .orderBy('createdAt', 'asc')
      .limit(300)
      .get();

    if (queueSnap.empty) return;

    const perOwner = new Map();

    queueSnap.docs.forEach((doc) => {
      const d = doc.data();
      const ownerId = d.ownerId;
      if (!ownerId) return;

      if (!perOwner.has(ownerId)) {
        perOwner.set(ownerId, {
          queuedCount: 0,
          inProgressCount: 0,
          oldestCreatedAt: null,
        });
      }

      const agg = perOwner.get(ownerId);
      const createdAt = d.createdAt?.toDate?.() || null;
      if (!agg.oldestCreatedAt || (createdAt && createdAt < agg.oldestCreatedAt)) {
        agg.oldestCreatedAt = createdAt;
      }

      if (d.status === OPS_JOB_STATUS.IN_PROGRESS) {
        agg.inProgressCount += 1;
      } else {
        agg.queuedCount += 1;
      }
    });

    for (const [ownerId, agg] of perOwner.entries()) {
      const oldestMinutes = agg.oldestCreatedAt
        ? Math.floor((now.getTime() - agg.oldestCreatedAt.getTime()) / (1000 * 60))
        : 0;

      const shouldAlert = (agg.queuedCount >= 4) || (oldestMinutes >= 30 && agg.queuedCount >= 2);
      if (!shouldAlert) continue;

      const alertRef = db.collection('ea_ops').doc(`ops_runner_capacity__${ownerId}`);
      const alertDoc = await alertRef.get();
      const lastAlertAt = alertDoc.exists ? alertDoc.data()?.lastAlertAt?.toDate?.() : null;
      if (lastAlertAt) {
        const elapsedHours = (now.getTime() - lastAlertAt.getTime()) / (1000 * 60 * 60);
        if (elapsedHours < 6) continue;
      }

      await sendEaReminderInternal(ownerId, {
        title: 'EA Capacity Alert',
        body: `I see ${agg.queuedCount} queued ops jobs (oldest ${oldestMinutes} minutes). Would you like me to add a third local runner?`,
        url: '/',
        tag: 'ops-runner-capacity',
        requireInteraction: true,
      });

      await alertRef.set({
        ownerId,
        lastAlertAt: FieldValue.serverTimestamp(),
        queuedCount: agg.queuedCount,
        inProgressCount: agg.inProgressCount,
        oldestMinutes,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }
);

// ============================================================
// connectGoogle — Exchange Google OAuth authorization code for tokens
// Client sends code from Google Identity Services popup.
// Stores access_token + refresh_token in users/{uid}/integrations/google
// ============================================================
exports.connectGoogle = onCall(
  { secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');
    const { code, redirectUri = 'postmessage' } = request.data || {};
    if (!code) throw new HttpsError('invalid-argument', 'code is required.');
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new HttpsError('failed-precondition', 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets.');
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await res.json();
    if (tokens.error) throw new HttpsError('internal', tokens.error_description || tokens.error);
    const uid = request.auth.uid;
    await db.collection('users').doc(uid).collection('integrations').doc('google').set({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiryDate: Date.now() + (tokens.expires_in || 3599) * 1000,
      scope: tokens.scope || '',
      connectedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    // Register in integrations index for scheduled polling
    await db.collection('ea_integrations').doc(uid).set({
      googleConnected: true,
      gmailScope: !!(tokens.scope || '').match(/gmail|mail\.google/),
      calendarScope: !!(tokens.scope || '').includes('calendar'),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ok: true, scope: tokens.scope || '' };
  }
);

// ============================================================
// getGoogleStatus — Returns whether Google is connected for this user
// ============================================================
exports.getGoogleStatus = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');
  const uid = request.auth.uid;
  try {
    const doc = await db.collection('users').doc(uid)
      .collection('integrations').doc('google').get();
    if (!doc.exists) return { connected: false };
    const { scope = '', connectedAt } = doc.data();
    return {
      connected: true,
      scope,
      hasCalendar: scope.includes('calendar'),
      hasGmail: !!(scope.match(/gmail|mail\.google/)),
      hasContacts: scope.includes('contacts'),
      connectedAt: connectedAt?.toDate?.()?.toISOString() || null,
    };
  } catch {
    return { connected: false };
  }
});

// ============================================================
// getAppConfig — Returns public client-side configuration
// (Google OAuth client ID is public — safe to expose to frontend)
// ============================================================
exports.getAppConfig = onCall(
  { secrets: [GOOGLE_CLIENT_ID] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');
    return {
      googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    };
  }
);

// ============================================================
// pollGmailForAlerts — Scheduled every 5 minutes
// Checks Gmail for new emails for all connected users and sends
// push notifications with sender name and subject.
// ============================================================
exports.pollGmailForAlerts = onSchedule(
  { schedule: 'every 5 minutes', secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET] },
  async () => {
    try {
      const connectionsSnap = await db.collection('ea_integrations')
        .where('googleConnected', '==', true)
        .where('gmailScope', '==', true)
        .limit(50)
        .get();
      if (connectionsSnap.empty) return;
      for (const connDoc of connectionsSnap.docs) {
        const uid = connDoc.id;
        const lastChecked = connDoc.data().gmailLastChecked;
        const accessToken = await getGoogleAuth(uid);
        if (!accessToken) continue;
        // Build Gmail query for recent new messages
        const afterDate = lastChecked
          ? (lastChecked.toDate ? lastChecked.toDate() : new Date(lastChecked))
          : new Date(Date.now() - 5 * 60 * 1000);
        const afterEpoch = Math.floor(afterDate.getTime() / 1000);
        const query = `is:inbox after:${afterEpoch}`;
        const listRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(query)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const listData = await listRes.json();
        if (!listData.messages || listData.messages.length === 0) {
          await connDoc.ref.update({ gmailLastChecked: FieldValue.serverTimestamp() });
          continue;
        }
        for (const msg of listData.messages.slice(0, 3)) {
          const detailRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const detail = await detailRes.json();
          const headers = detail.payload?.headers || [];
          const from = headers.find((h) => h.name === 'From')?.value || 'Unknown';
          const subject = headers.find((h) => h.name === 'Subject')?.value || '(No subject)';
          const fromName = (from.match(/^"?([^"<]+)"?\s*</)?.[1] || from).trim().slice(0, 60);
          await sendEaReminderInternal(uid, {
            title: `\u{1F4E7} ${fromName}`,
            body: subject.slice(0, 120),
            url: '/',
            tag: `email-${msg.id}`,
            requireInteraction: false,
          });
        }
        await connDoc.ref.update({ gmailLastChecked: FieldValue.serverTimestamp() });
      }
    } catch (err) {
      console.error('pollGmailForAlerts error:', err.message);
    }
  }
);

