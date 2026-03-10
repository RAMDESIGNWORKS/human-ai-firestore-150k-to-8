# AI Executive Assistant — Board of Directors Stack

**RMcManus Holdings LLC — Production-deployed, built solo**

> Cut Firestore reads from 151K/week to 8 by replacing a polling loop with `onSnapshot`. Zero infrastructure changes — just a listener swap in the local worker.

---

## The Architecture Win

The local worker used to poll Firestore every 4 seconds for new jobs:

```
poll every 4s × 60 × 60 × 24 × 7 = 151,200 reads/week
(43% of the free tier, just to check "anything new?")
```

Switched to `onSnapshot` — Firestore pushes changes to the worker the instant they happen:

```
onSnapshot:
  1 read on connect
  1 read per job dispatched
  ≈ 8 reads/week total
```

The worker (`worker/ops-worker.js`) now uses `firebase-admin` and opens a persistent listener on `ops_jobs` filtered to `ownerId == OWNER_ID` and `status in [queued, approved]`. When the React dashboard approves a command, Firestore pushes it directly to the worker — no polling, no delay.

---

## What This Is

A private AI executive stack that gives me a board of directors I can consult any time:

| Advisor | Domain |
|---------|--------|
| CFO | Finance, cash flow, budgets, projections |
| Tax Strategist | Tax planning, deductions, entity structure, IRS |
| Legal Counsel | Contracts, liability, IP, compliance, employment law |
| COO | Operations, workflows, team, vendors, execution |
| CMO | Marketing, advertising, brand, campaigns |
| CPO | Product, technology, platform, development |

Each advisor has a tuned system prompt. The EA routes your question to the right advisor automatically via keyword scoring, then returns the response with a colored advisor badge.

The local worker extends this into desktop control — the EA can read your file system, scan installed programs, search project files, and execute approved operations directly on the machine. Commands flow through Firestore so the approval step always stays in the web dashboard.

---

## Stack

- **Frontend**: React (CRA) + Firebase Hosting
- **Backend**: Firebase Cloud Functions v2 (Node.js)
- **Database**: Firestore
- **Worker**: Node.js (`firebase-admin`) running locally on Windows
- **Auth**: Firebase Auth (Google sign-in)
- **Browser Companion**: Chrome extension — sends page context to EA for guided walkthroughs

---

## Repo Structure

```
AI-Executive-Assistant/
├── src/
│   ├── App.js                          ← Auth gate
│   ├── components/
│   │   └── ExecutiveAssistant.jsx      ← Main EA chat interface
│   └── prompts/
│       └── executive-assistant.js     ← Advisor system prompts + routing
├── functions/
│   └── index.js                       ← Cloud Functions: eaChat, ops job dispatch
├── worker/
│   ├── ops-worker.js                  ← onSnapshot listener + desktop job executor
│   ├── start-worker.ps1               ← PowerShell launcher
│   ├── worker-config.example.json     ← Config template (copy → worker-config.json)
│   └── package.json                   ← firebase-admin dependency
├── browser-companion/                 ← Chrome extension
├── public/
├── firebase.json
├── firestore.rules
└── .env.example
```

---

## Worker Setup

The worker runs locally on your Windows machine and connects directly to Firestore via a service account key.

### 1. Get a service account key

Firebase Console → Project Settings → Service Accounts → **Generate new private key**

Save as `worker/service-account.json` (already in `.gitignore` — never committed).

### 2. Configure

```bash
cp worker/worker-config.example.json worker/worker-config.json
# Fill in HOST_MONITOR_TOKEN, OWNER_ID, PROJECTS_ROOT, INDEX_URL
```

### 3. Install and run

```bash
cd worker
npm install
.\start-worker.ps1
```

The worker will:
- Connect to Firestore and open an `onSnapshot` listener
- Immediately scan and upload your local project index
- Schedule a weekly program audit (Saturdays at 4 AM)
- Execute approved jobs from the EA dashboard in real time

---

## Full App Setup

### Firebase project

```bash
firebase login
firebase init    # Hosting, Functions, Firestore
```

### Environment variables

```bash
cp .env.example .env
# Fill in your Firebase web app credentials
```

### Firebase secrets

```bash
firebase functions:secrets:set OPENAI_API_KEY
firebase functions:secrets:set BROWSER_COMPANION_TOKEN
firebase functions:secrets:set HOST_MONITOR_TOKEN
```

### Install and run

```bash
npm install
cd functions && npm install && cd ..
npm start              # local dev
npm run deploy         # build + deploy to Firebase
```


