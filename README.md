# AI Executive Assistant
**RMcManus Holdings LLC — Internal Business Operations**

A private AI Chief of Staff that routes executive questions to the right advisor and manages the board meeting calendar.

---

## Architecture

```
AI-Executive-Assistant/
├── src/
│   ├── App.js                         ← Root: auth gate + login screen
│   ├── index.js                       ← React entry point
│   ├── components/
│   │   └── ExecutiveAssistant.jsx     ← Main EA chat interface
│   └── prompts/
│       └── executive-assistant.js    ← EA system prompt + advisor domains + meeting types
├── functions/
│   └── index.js                      ← Firebase Cloud Functions (eaChat, getEaSessions, getEaSession)
├── public/
│   └── index.html
├── firebase.json
├── firestore.rules
├── .env.example                       ← Copy to .env and fill in
└── package.json
```

---

## Board Members

| Advisor | Domain |
|---------|--------|
| CFO | Finance, cash flow, budgets, projections |
| Tax Strategist | Tax planning, deductions, entity structure, IRS |
| Legal Counsel | Contracts, liability, IP, compliance, employment law |
| COO | Operations, workflows, team, vendors, execution |
| CMO | Marketing, advertising, brand, campaigns |
| CPO | Product, technology, platform, development |

Board member AI prompts will be added in Day 2.

---

## Setup

### 1. Firebase project

Create a new Firebase project (or reuse an existing one under RMCMANUS HOLDINGS LLC).

```
firebase login
firebase init    # select: Hosting, Functions, Firestore
```

### 2. Environment variables

```bash
cp .env.example .env
# Fill in your Firebase web app credentials
```

### 3. Firebase secrets (Cloud Functions)

```bash
firebase functions:secrets:set OPENAI_API_KEY
# Enter your OpenAI API key when prompted

firebase functions:secrets:set BROWSER_COMPANION_TOKEN
# Set a long random token for your browser companion extension

firebase functions:secrets:set HOST_MONITOR_TOKEN
# Set a long random token for local D: drive monitor ingest
```

### 4. Install and run

```bash
npm install
cd functions && npm install && cd ..
npm start              # local dev
npm run deploy         # build + deploy to Firebase
```

---

## Day 1 What's Working

- EA chat interface with full conversation history
- Advisor routing based on keyword scoring (`suggestAttendees()`)
- Colored advisor badges on EA responses
- Session persistence in Firestore (`ea_sessions/{id}/messages/`)
- Firebase Auth login gate
- New session button

## Browser Companion (Guide-Through-Web)

The `browser-companion/` Chrome extension sends current page context to Firebase so EA can guide you through complex flows.

Important security rule:
- Do not give the extension or EA your raw passwords.
- Use your browser password manager and normal sign-in flows.
- Companion captures page context (URL/title/help links/headings), not password values.

### Setup

1. Deploy functions so `browserCompanionIngest` is live.
2. In Chrome, open `chrome://extensions`, enable Developer Mode, click **Load unpacked**, and select `browser-companion/`.
3. Open extension **Settings** and fill:
	- `Endpoint URL`: `https://us-central1-<your-project-id>.cloudfunctions.net/browserCompanionIngest`
	- `Companion Token`: value used in `BROWSER_COMPANION_TOKEN`
	- `Owner ID`: your stable user identifier (recommended: Firebase Auth uid)
4. Open any website and click **Analyze This Page** in the extension popup.
5. EA returns step-by-step guidance based on current page context.

## Local D: Drive Monitoring (Windows)

To allow EA to actively monitor your local D: drive and process activity, run the local monitor companion script.

1. Deploy functions so `hostMonitorIngest` and `getHostMonitorStatus` are live.
2. Set `HOST_MONITOR_TOKEN` via Firebase Secrets.
3. Run:

```powershell
Set-Location "D:\BUSINESS\9 RMCMANUS HOLDINGS LLC\AI-Executive-Assistant"
$endpoint = "https://us-central1-<your-project-id>.cloudfunctions.net/hostMonitorIngest"
$token = "<HOST_MONITOR_TOKEN>"
$owner = "<your firebase auth uid>"

.\local-monitor\monitor-d-drive.ps1 -EndpointUrl $endpoint -MonitorToken $token -OwnerId $owner
```

Detailed instructions: `local-monitor/README.md`.

## Days 2–5 (Queued)

- **Day 2**: Board member system prompts (user to provide) + full routing pipeline
- **Day 3**: Firestore schema for meetings/ and actionItems/
- **Day 4**: EA Dashboard — open items, meeting calendar, advisor status
- **Day 5**: Testing, proactive reminders, polish
