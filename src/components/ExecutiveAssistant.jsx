import React, { useState, useRef, useEffect, useCallback } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';

// ============================================================
// ExecutiveAssistant.jsx
// Primary EA chat interface — PWA / mobile-first
// ============================================================

const ADVISOR_COLORS = {
  CFO:   { bg: '#0d2137', border: '#1a5276', label: '#5dade2' },
  Tax:   { bg: '#1a1a0d', border: '#7d6608', label: '#f9e79f' },
  Legal: { bg: '#1a0d0d', border: '#922b21', label: '#f1948a' },
  COO:   { bg: '#0d1a0d', border: '#1e8449', label: '#82e0aa' },
  CMO:   { bg: '#1a0d1a', border: '#76448a', label: '#c39bd3' },
  CPO:   { bg: '#0d1a1a', border: '#148f77', label: '#76d7c4' },
};

const ADVISOR_FULL_NAMES = {
  CFO:   'Chief Financial Officer',
  Tax:   'Tax Strategist',
  Legal: 'Legal Counsel',
  COO:   'Chief Operating Officer',
  CMO:   'Chief Marketing Officer',
  CPO:   'Chief Product Officer',
};

function parseAdvisorChunks(content) {
  if (!content) return [{ bot: 'EA', text: '' }];
  const regex = /\*\*(CFO|Tax Strategist|Legal Counsel|COO|CMO|CPO|Tax|Legal):\*\*/g;
  const BOT_MAP = { 'Tax Strategist': 'Tax', 'Legal Counsel': 'Legal' };
  const chunks = [];
  let lastIndex = 0;
  let lastBot = 'EA';
  let match;
  while ((match = regex.exec(content)) !== null) {
    const text = content.slice(lastIndex, match.index).trim();
    if (text) chunks.push({ bot: lastBot, text });
    lastBot = BOT_MAP[match[1]] || match[1];
    lastIndex = match.index + match[0].length;
  }
  const remaining = content.slice(lastIndex).trim();
  if (remaining) chunks.push({ bot: lastBot, text: remaining });
  return chunks.length ? chunks : [{ bot: 'EA', text: content }];
}

const OPENAI_VOICE_OPTIONS = ['shimmer', 'nova', 'alloy', 'echo', 'fable', 'onyx'];
const ADVISOR_KEYS = ['CFO', 'Tax', 'Legal', 'COO', 'CMO', 'CPO'];
const BOT_KEYS = ['EA', ...ADVISOR_KEYS];
const PERSONA_OPTIONS = ['chief_of_staff', 'jarvis', 'coach', 'concise'];

function AdvisorBadge({ advisor }) {
  const style = ADVISOR_COLORS[advisor] || { bg: '#111', border: '#333', label: '#aaa' };
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '2px 8px',
      borderRadius: '12px',
      fontSize: '11px',
      fontWeight: 600,
      letterSpacing: '0.5px',
      backgroundColor: style.bg,
      border: `1px solid ${style.border}`,
      color: style.label,
      flexShrink: 0,
    }}>
      {advisor}
    </span>
  );
}

function Message({ msg }) {
  const isUser = msg.role === 'user';

  if (!isUser) {
    const chunks = parseAdvisorChunks(msg.content);
    const multiChunk = chunks.length > 1 || chunks[0]?.bot !== 'EA';
    return (
      <div className="ea-message" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', marginBottom: '20px' }}>
        {chunks.map((chunk, i) => {
          const colors = ADVISOR_COLORS[chunk.bot];
          return (
            <div key={i} style={{ maxWidth: '75%', marginBottom: i < chunks.length - 1 ? '8px' : '0' }}>
              {multiChunk && (
                <div style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.6px',
                  textTransform: 'uppercase',
                  color: colors ? colors.label : '#5ba3f5',
                  marginBottom: '4px',
                  paddingLeft: '4px',
                }}>
                  {chunk.bot === 'EA' ? 'EA' : (ADVISOR_FULL_NAMES[chunk.bot] || chunk.bot)}
                </div>
              )}
              <div
                className="ea-message-bubble"
                style={{
                  padding: '14px 18px',
                  borderRadius: '18px 18px 18px 4px',
                  backgroundColor: colors ? colors.bg : '#0d1220',
                  border: `1px solid ${colors ? colors.border : '#1e2a3a'}`,
                  color: '#e8edf5',
                  fontSize: '15px',
                  lineHeight: '1.7',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {renderMarkdown(chunk.text)}
              </div>
            </div>
          );
        })}

        {/* Advisor routing badges */}
        {msg.suggestedAdvisors && msg.suggestedAdvisors.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
            {msg.suggestedAdvisors.map(a => <AdvisorBadge key={a} advisor={a} />)}
          </div>
        )}

        <span style={{ fontSize: '11px', color: '#4a5568', marginTop: '4px' }}>
          EA · {formatTime(msg.timestamp)}
        </span>
      </div>
    );
  }

  // User message
  return (
    <div className="ea-message" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginBottom: '20px' }}>
      <div
        className="ea-message-bubble"
        style={{
          maxWidth: '75%',
          padding: '14px 18px',
          borderRadius: '18px 18px 4px 18px',
          backgroundColor: '#1a3a5c',
          border: '1px solid #2a5280',
          color: '#e8edf5',
          fontSize: '15px',
          lineHeight: '1.7',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {renderMarkdown(msg.content)}
      </div>
      <span style={{ fontSize: '11px', color: '#4a5568', marginTop: '4px' }}>
        You · {formatTime(msg.timestamp)}
      </span>
    </div>
  );
}

// Minimal markdown renderer — bold only
function renderMarkdown(text) {
  if (!text) return null;
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ color: '#a0c4ff' }}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

const THINKING_PHRASES = [
  'On it…',
  'Thinking…',
  'Working on it…',
  'Pulling this together…',
  'One moment…',
  'Checking on that…',
  'Looking into it…',
  'Processing…',
  'Almost there…',
];

function ThinkingIndicator() {
  const [phrase, setPhrase] = React.useState(THINKING_PHRASES[0]);
  const [fade, setFade] = React.useState(true);

  React.useEffect(() => {
    let idx = 0;
    const cycle = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        idx = (idx + 1) % THINKING_PHRASES.length;
        setPhrase(THINKING_PHRASES[idx]);
        setFade(true);
      }, 200);
    }, 2200);
    return () => clearInterval(cycle);
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 2px' }}>
      <div style={{ display: 'flex', gap: '4px' }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{
            width: '5px', height: '5px',
            borderRadius: '50%',
            backgroundColor: '#4a9eff',
            animation: `pulse 1.0s ease-in-out ${i * 0.18}s infinite`,
          }} />
        ))}
      </div>
      <span style={{
        fontSize: '13px',
        color: '#8899aa',
        fontStyle: 'italic',
        opacity: fade ? 1 : 0,
        transition: 'opacity 0.2s ease',
        userSelect: 'none',
      }}>{phrase}</span>
    </div>
  );
}

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function parseLooseDueAt(text) {
  const lower = text.toLowerCase();
  const now = new Date();

  if (lower.includes('tomorrow')) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }

  if (lower.includes('next week')) {
    const d = new Date(now);
    d.setDate(d.getDate() + 7);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }

  return null;
}

function looksLikeTaskRequest(text) {
  const t = text.toLowerCase();
  return /remind me to|dont let me forget|don't let me forget|task:|follow up on|i need to/.test(t);
}

function looksLikeProgramDiscovery(text) {
  const t = text.toLowerCase();
  return /do i have (a|an) program|what program can|which app can|scan.*(computer|drive)|installed program/.test(t);
}

function looksLikeOpsRequest(text) {
  const t = text.toLowerCase();
  return (
    /open\s+.*vs\s*code|open\s+vscode|start\s+working\s+on|work\s+on\s+this\s+project|have\s+.*open\s+.*folder/.test(t) ||
    /vs\s*code|workspace|project\s+folder|folder\s+project|claude\s+sonnet|copilot|deploy|deployment|publish\s+live/.test(t) ||
    /backdrop|hero\s+image|background\s+image|install\s+.*\.jpg|install\s+.*\.png/.test(t)
  );
}

function toSpeechFriendlyText(text) {
  if (!text) return '';

  const blockedLinePatterns = [
    /claude|sonnet|gpt|copilot|advisor\s*:|routing\s+to:/i,
    /^(cfo|coo|cpo|cmo|legal|tax)\s*:/i,
    /^status\s*:/i,
    /^action\s*:/i,
    /^result\s*:/i,
    /^next\s*:/i,
    /ops\s+job|local\s+worker|automation|queued|in\s+progress|blocked|terminal|firebase|deploy/i,
    /function\s+url|secret|token|manifest|callable/i,
  ];

  let cleaned = text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (blockedLinePatterns.some((p) => p.test(trimmed))) return false;
      return true;
    })
    .join(' ');

  // Replace fenced code blocks with a short spoken placeholder.
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' Code snippet shared on screen. ');

  // Replace inline code marks.
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

  // Strip markdown emphasis/headers/list markers.
  cleaned = cleaned
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '');

  // Normalize heavy symbol runs that sound robotic when read aloud.
  cleaned = cleaned
    .replace(/[{}\[\]<>|\\/~^_=+*#%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Speak only a brief summary so long responses remain readable on screen.
  const sentenceChunks = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let spoken = sentenceChunks.slice(0, 2).join(' ');
  if (!spoken) spoken = cleaned;

  const MAX_SPOKEN_CHARS = 260;
  if (spoken.length > MAX_SPOKEN_CHARS) {
    spoken = `${spoken.slice(0, MAX_SPOKEN_CHARS).trim()}...`;
  }

  if (cleaned.length > spoken.length + 20) {
    spoken = `${spoken} I left the full details on screen.`;
  }

  return spoken;
}

function splitMessageForVoices(text) {
  const source = String(text || '');
  const chunks = [];
  const advisorRegex = /\*\*(CFO|Tax Strategist|Legal Counsel|COO|CMO|CPO|Tax|Legal):\*\*([\s\S]*?)(?=\n\n\*\*(?:CFO|Tax Strategist|Legal Counsel|COO|CMO|CPO|Tax|Legal):\*\*|$)/g;

  const firstAdvisorAt = source.search(advisorRegex);
  const eaPart = firstAdvisorAt >= 0 ? source.slice(0, firstAdvisorAt) : source;
  const eaText = toSpeechFriendlyText(eaPart);
  if (eaText) chunks.push({ bot: 'EA', text: eaText });

  advisorRegex.lastIndex = 0;
  let match;
  while ((match = advisorRegex.exec(source)) !== null) {
    const rawBot = (match[1] || '').trim();
    const bot = rawBot === 'Tax Strategist' ? 'Tax' : rawBot === 'Legal Counsel' ? 'Legal' : rawBot;
    const speechText = toSpeechFriendlyText(match[2] || '');
    if (speechText) chunks.push({ bot, text: speechText });
  }

  return chunks;
}

// ============================================================
// FOREGROUND NOTIFICATION BANNER
// Shown when the app is open and a push arrives
// ============================================================
function ForegroundNotification({ message, onDismiss }) {
  if (!message) return null;
  const { title, body } = message.notification || {};
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0,
      padding: '12px 16px',
      paddingTop: 'max(12px, calc(12px + env(safe-area-inset-top, 0px)))',
      backgroundColor: '#0d1824',
      borderBottom: '1px solid #1e3a5c',
      display: 'flex', alignItems: 'center', gap: '12px',
      zIndex: 300,
      animation: 'eaSlideDown 0.3s ease',
    }}>
      <span style={{ fontSize: '20px' }}>🔔</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: '#a0c4ff',
          fontFamily: "'Inter', sans-serif" }}>
          {title || 'EA Reminder'}
        </div>
        {body && (
          <div style={{ fontSize: '12px', color: '#6b7a99', marginTop: '2px',
            fontFamily: "'Inter', sans-serif" }}>{body}</div>
        )}
      </div>
      <button onClick={onDismiss} style={{
        background: 'none', border: 'none', color: '#4a5568',
        fontSize: '20px', cursor: 'pointer', padding: '4px', lineHeight: 1,
        minWidth: '44px', minHeight: '44px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>×</button>
    </div>
  );
}

// ============================================================
// NOTIFICATION PERMISSION PROMPT
// ============================================================
function NotificationPrompt({ onEnable, onDismiss }) {
  return (
    <div className="notification-prompt">
      <span className="notification-prompt-icon">🔔</span>
      <div className="notification-prompt-text">
        <div className="notification-prompt-title">Enable EA Reminders</div>
        <div className="notification-prompt-sub">
          Get notified for meetings and open action items.
        </div>
      </div>
      <button className="notification-enable-btn" onClick={onEnable}>
        Enable
      </button>
      <button onClick={onDismiss} style={{
        background: 'none', border: 'none', color: '#4a5568',
        fontSize: '18px', cursor: 'pointer', padding: '4px',
        minWidth: '36px', minHeight: '36px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>×</button>
    </div>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================

export default function ExecutiveAssistant({ user, pushNotifications, onSignOut }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [error, setError] = useState(null);
  const [showNotifPrompt, setShowNotifPrompt] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [isMobileView, setIsMobileView] = useState(() => window.innerWidth < 640);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window !== 'undefined'
      ? Math.round(window.visualViewport?.height || window.innerHeight || 0)
      : 0
  );
  const [autoSpeak, setAutoSpeak] = useState(() => {
    if (typeof window === 'undefined') return true;
    const saved = window.localStorage.getItem('eaAutoSpeak');
    return saved == null ? true : saved === 'true';
  });
  const [speechMode, setSpeechMode] = useState(() => {
    if (typeof window === 'undefined') return 'browser';
    const saved = window.localStorage.getItem('eaSpeechMode');
    return saved === 'openai' ? 'openai' : 'browser';
  });
  const [openAiVoice, setOpenAiVoice] = useState(() => {
    if (typeof window === 'undefined') return 'shimmer';
    const saved = window.localStorage.getItem('eaOpenAiVoice');
    return OPENAI_VOICE_OPTIONS.includes(saved) ? saved : 'shimmer';
  });
  const [personaProfile] = useState(() => {
    if (typeof window === 'undefined') return 'chief_of_staff';
    const saved = window.localStorage.getItem('eaPersonaProfile');
    return PERSONA_OPTIONS.includes(saved) ? saved : 'chief_of_staff';
  });
  const [includeAdvisorVoices, setIncludeAdvisorVoices] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('eaIncludeAdvisorVoices') === 'true';
  });
  const [advisorVoiceMode, setAdvisorVoiceMode] = useState(() => {
    if (typeof window === 'undefined') return 'auto';
    const saved = window.localStorage.getItem('eaAdvisorVoiceMode');
    return ['auto', 'all', 'manual'].includes(saved) ? saved : 'auto';
  });
  const [selectedAdvisors, setSelectedAdvisors] = useState(() => {
    if (typeof window === 'undefined') return ['CPO'];
    const saved = window.localStorage.getItem('eaSelectedAdvisors');
    try {
      const parsed = JSON.parse(saved || '[]');
      return Array.isArray(parsed) ? parsed.filter((a) => ADVISOR_KEYS.includes(a)) : ['CPO'];
    } catch {
      return ['CPO'];
    }
  });
  const [voiceByBot, setVoiceByBot] = useState(() => {
    if (typeof window === 'undefined') {
      return { EA: 'shimmer', CFO: 'alloy', Tax: 'nova', Legal: 'echo', COO: 'onyx', CMO: 'fable', CPO: 'nova' };
    }
    const defaults = { EA: 'shimmer', CFO: 'alloy', Tax: 'nova', Legal: 'echo', COO: 'onyx', CMO: 'fable', CPO: 'nova' };
    const saved = window.localStorage.getItem('eaVoiceByBot');
    try {
      const parsed = JSON.parse(saved || '{}');
      const merged = { ...defaults, ...(parsed || {}) };
      BOT_KEYS.forEach((k) => {
        if (!OPENAI_VOICE_OPTIONS.includes(merged[k])) merged[k] = defaults[k];
      });
      return merged;
    } catch {
      return defaults;
    }
  });
  const [speaking, setSpeaking] = useState(false);
  const [micListening, setMicListening] = useState(false);
  const [micSupported] = useState(() =>
    typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  );
  const [speechSupported] = useState(() =>
    typeof window !== 'undefined' && !!window.speechSynthesis && !!window.SpeechSynthesisUtterance
  );
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleConnecting, setGoogleConnecting] = useState(false);
  const [gisLoaded, setGisLoaded] = useState(false);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const recognitionRef = useRef(null);
  const lastSpokenKeyRef = useRef(null);
  const audioRef = useRef(null);
  const handledGoogleCodeRef = useRef(false);
  const pendingTranscriptRef = useRef('');
  const manualMicStopRef = useRef(false);

  // Firebase callables needed in useEffects — must be declared before first useEffect referencing them
  const functions = getFunctions();
  const connectGoogleFn = httpsCallable(functions, 'connectGoogle');
  const getGoogleStatusFn = httpsCallable(functions, 'getGoogleStatus');

  // Responsive: track mobile breakpoint
  useEffect(() => {
    const onResize = () => setIsMobileView(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // iOS Safari/PWA can report unstable 100vh; track visual viewport height directly.
  useEffect(() => {
    const updateViewportHeight = () => {
      const next = Math.round(window.visualViewport?.height || window.innerHeight || 0);
      if (next > 0) setViewportHeight(next);
    };

    updateViewportHeight();
    window.addEventListener('resize', updateViewportHeight);
    window.addEventListener('orientationchange', updateViewportHeight);
    window.visualViewport?.addEventListener('resize', updateViewportHeight);
    window.visualViewport?.addEventListener('scroll', updateViewportHeight);

    return () => {
      window.removeEventListener('resize', updateViewportHeight);
      window.removeEventListener('orientationchange', updateViewportHeight);
      window.visualViewport?.removeEventListener('resize', updateViewportHeight);
      window.visualViewport?.removeEventListener('scroll', updateViewportHeight);
    };
  }, []);

  // Load Google Identity Services script
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => setGisLoaded(true);
    document.head.appendChild(script);
    return () => { try { document.head.removeChild(script); } catch {} };
  }, []);

  // Check Google connection status on mount
  useEffect(() => {
    if (!user) return;
    getGoogleStatusFn({}).then((r) => {
      setGoogleConnected(r?.data?.connected || false);
    }).catch(() => {});
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Complete Google redirect flow on mobile Safari by exchanging auth code from URL params.
  useEffect(() => {
    if (!user || handledGoogleCodeRef.current) return;

    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');

    if (!code && !error) return;

    handledGoogleCodeRef.current = true;

    const clearOauthParams = () => {
      ['code', 'scope', 'authuser', 'prompt', 'error', 'state'].forEach((key) => {
        url.searchParams.delete(key);
      });
      window.history.replaceState({}, document.title, url.toString());
    };

    if (state !== 'ea_google_connect') {
      clearOauthParams();
      return;
    }

    if (error) {
      clearOauthParams();
      setGoogleConnecting(false);
      alert(`Google connection failed: ${error}`);
      return;
    }

    setGoogleConnecting(true);
    connectGoogleFn({ code, redirectUri: `${window.location.origin}/` })
      .then(() => {
        setGoogleConnected(true);
      })
      .catch((err) => {
        console.error('Connect Google redirect failed:', err);
        alert('Google connection failed: ' + (err?.message || 'Unknown error'));
      })
      .finally(() => {
        clearOauthParams();
        setGoogleConnecting(false);
      });
  }, [connectGoogleFn, user]);

  async function handleConnectGoogle() {
    if (!gisLoaded) { alert('Google auth is loading, try again in a moment.'); return; }
    const isStandalone =
      (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches) ||
      (typeof navigator !== 'undefined' && navigator.standalone);
    const isIPhoneSafari = typeof navigator !== 'undefined'
      && /iPhone|iPad|iPod/i.test(navigator.userAgent)
      && /Safari/i.test(navigator.userAgent)
      && !/CriOS|FxiOS|EdgiOS/i.test(navigator.userAgent);

    if (isStandalone) {
      alert('Google connection must be started from Safari, not the Home Screen app.\n\nOpen the EA in Safari, tap Connect Google there once, finish the Google approval, then return to the Home Screen icon.');
      return;
    }

    setGoogleConnecting(true);
    try {
      const connectTimeout = window.setTimeout(() => {
        setGoogleConnecting(false);
        alert('Google sign-in did not complete.\n\nIf you are on iPhone, open the EA in Safari and try Connect Google there. The Home Screen app can block the Google popup flow.');
      }, 20000);

      const configResult = await getAppConfigFn({});
      const clientId = configResult?.data?.googleClientId;
      if (!clientId) {
        window.clearTimeout(connectTimeout);
        alert('Google integration is not configured yet.\n\nTo enable it:\n1. Enable Calendar API and Gmail API in Google Cloud Console\n2. Create OAuth 2.0 credentials (Web Application)\n3. Run: firebase functions:secrets:set GOOGLE_CLIENT_ID\n4. Run: firebase functions:secrets:set GOOGLE_CLIENT_SECRET\n5. Redeploy functions');
        setGoogleConnecting(false);
        return;
      }
      const redirectUri = `${window.location.origin}/`;
      const client = window.google.accounts.oauth2.initCodeClient({
        client_id: clientId,
        scope: [
          'https://www.googleapis.com/auth/calendar',
          'https://mail.google.com/',
          'https://www.googleapis.com/auth/contacts.readonly',
        ].join(' '),
        ux_mode: isIPhoneSafari ? 'redirect' : 'popup',
        redirect_uri: redirectUri,
        state: 'ea_google_connect',
        error_callback: () => {
          window.clearTimeout(connectTimeout);
          setGoogleConnecting(false);
          alert('Google sign-in popup could not complete.\n\nOn iPhone, use Safari for the initial Google connection, then come back to the Home Screen app after it is connected.');
        },
        callback: async (response) => {
          window.clearTimeout(connectTimeout);
          if (response.error) {
            console.error('Google auth error:', response.error);
            setGoogleConnecting(false);
            return;
          }
          try {
            await connectGoogleFn({ code: response.code, redirectUri: 'postmessage' });
            setGoogleConnected(true);
          } catch (err) {
            console.error('Connect Google failed:', err);
            alert('Google connection failed: ' + (err?.message || 'Unknown error'));
          }
          setGoogleConnecting(false);
        },
      });
      client.requestCode();
    } catch (err) {
      console.error('Google connect setup failed:', err);
      setGoogleConnecting(false);
    }
  }

  function focusInput() {
    // Defer focus until after React applies disabled=false.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        textareaRef.current.focus();
        const end = textareaRef.current.value.length;
        textareaRef.current.setSelectionRange(end, end);
      });
    });
  }

  const eaChat = httpsCallable(functions, 'eaChat');
  const executeAutomation = httpsCallable(functions, 'executeAutomation');
  const upsertEaTask = httpsCallable(functions, 'upsertEaTask');
  const listEaTasks = httpsCallable(functions, 'listEaTasks');
  const completeEaTask = httpsCallable(functions, 'completeEaTask');
  const suggestProgramsForTask = httpsCallable(functions, 'suggestProgramsForTask');
  const submitOpsJob = httpsCallable(functions, 'submitOpsJob');
  const listPendingOpsApprovals = httpsCallable(functions, 'listPendingOpsApprovals');
  const decideOpsApproval = httpsCallable(functions, 'decideOpsApproval');
  const synthesizeEaSpeech = httpsCallable(functions, 'synthesizeEaSpeech');
  const getAppConfigFn = httpsCallable(functions, 'getAppConfig');

  const {
    permission,
    foregroundMessage,
    dismissForegroundMessage,
    requestPermission,
    needsPrompt,
  } = pushNotifications || {};

  // Welcome message
  useEffect(() => {
    setMessages([{
      role: 'assistant',
      content: `Good ${getTimeOfDay()}. What's on your plate?`,
      timestamp: new Date().toISOString(),
      suggestedAdvisors: [],
    }]);

    focusInput();
  }, []);

  // Show notification prompt 5s after load
  useEffect(() => {
    if (needsPrompt) {
      const t = setTimeout(() => setShowNotifPrompt(true), 5000);
      return () => clearTimeout(t);
    }
  }, [needsPrompt]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Auto-dismiss foreground notification after 5s
  useEffect(() => {
    if (foregroundMessage) {
      const t = setTimeout(() => dismissForegroundMessage?.(), 5000);
      return () => clearTimeout(t);
    }
  }, [foregroundMessage, dismissForegroundMessage]);

  // Persist auto-speak preference.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('eaAutoSpeak', String(autoSpeak));
  }, [autoSpeak]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('eaSpeechMode', speechMode);
  }, [speechMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('eaOpenAiVoice', openAiVoice);
  }, [openAiVoice]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('eaPersonaProfile', personaProfile);
  }, [personaProfile]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('eaIncludeAdvisorVoices', String(includeAdvisorVoices));
  }, [includeAdvisorVoices]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('eaAdvisorVoiceMode', advisorVoiceMode);
  }, [advisorVoiceMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('eaSelectedAdvisors', JSON.stringify(selectedAdvisors));
  }, [selectedAdvisors]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('eaVoiceByBot', JSON.stringify(voiceByBot));
  }, [voiceByBot]);

  // Keep a fresh voice list when browsers asynchronously load voices.
  useEffect(() => {
    if (!speechSupported) return undefined;
    const refreshVoices = () => {
      window.speechSynthesis.getVoices();
    };
    refreshVoices();
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', refreshVoices);
    };
  }, [speechSupported]);

  const stopSpeech = useCallback(() => {
    if (speechSupported) {
      window.speechSynthesis.cancel();
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    setSpeaking(false);
  }, [speechSupported]);

  const speakWithBrowser = useCallback((text) => {
    if (!speechSupported || !text) return;
    const synth = window.speechSynthesis;
    const utterance = new window.SpeechSynthesisUtterance(text);
    const voices = synth.getVoices();
    const preferredVoice =
      voices.find((voice) => /samantha/i.test(voice.name)) ||
      voices.find((voice) => /^en-US$/i.test(voice.lang)) ||
      voices.find((voice) => /^en/i.test(voice.lang)) ||
      null;

    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }

    utterance.rate = 1.08;
    utterance.pitch = 0.95;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);

    synth.cancel();
    synth.speak(utterance);
  }, [speechSupported]);

  const speakWithOpenAi = useCallback(async (text, voiceOverride = null) => {
    if (!text) return;
    setSpeaking(true);

    const voice = voiceOverride && OPENAI_VOICE_OPTIONS.includes(voiceOverride)
      ? voiceOverride
      : openAiVoice;
    const r = await synthesizeEaSpeech({ text, voice });
    const mimeType = r?.data?.mimeType || 'audio/mpeg';
    const audioBase64 = r?.data?.audioBase64 || '';
    if (!audioBase64) throw new Error('No audio returned from TTS');

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
    audioRef.current = audio;

    // Return a promise that resolves only when this clip finishes playing
    await new Promise((resolve) => {
      audio.onended = () => {
        if (audioRef.current === audio) audioRef.current = null;
        resolve();
      };
      audio.onerror = () => {
        if (audioRef.current === audio) audioRef.current = null;
        resolve(); // still resolve so the queue keeps moving
      };
      audio.play().catch(() => resolve());
    });
  }, [synthesizeEaSpeech, openAiVoice]);

  useEffect(() => {
    if (!autoSpeak || messages.length === 0) return;

    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.content) return;

    const speakKey = `${last.timestamp || ''}:${last.content}`;
    if (speakKey === lastSpokenKeyRef.current) return;
    lastSpokenKeyRef.current = speakKey;
    const speechChunks = splitMessageForVoices(last.content);

    let cancelled = false;

    (async () => {
      try {
        stopSpeech();
        if (speechChunks.length === 0) {
          setSpeaking(false);
          return;
        }

        if (speechMode === 'openai') {
          setSpeaking(true);
          for (const chunk of speechChunks) {
            if (cancelled) break;
            // eslint-disable-next-line no-await-in-loop
            await speakWithOpenAi(chunk.text, voiceByBot[chunk.bot] || voiceByBot.EA || 'shimmer');
          }
          if (!cancelled) setSpeaking(false);
        } else if (speechSupported) {
          speakWithBrowser(speechChunks.map((c) => c.text).join(' '));
        }
      } catch (err) {
        if (cancelled) return;
        console.error('TTS playback error:', err);
        // Fallback to browser speech when premium mode fails.
        if (speechMode === 'openai' && speechSupported) {
          speakWithBrowser(speechChunks.map((c) => c.text).join(' '));
          return;
        }
        setSpeaking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [messages, autoSpeak, speechMode, speechSupported, speakWithBrowser, speakWithOpenAi, stopSpeech, voiceByBot]);

  useEffect(() => {
    if (!speechSupported) return undefined;
    return () => {
      window.speechSynthesis.cancel();
    };
  }, [speechSupported]);

  // Poll approvals that require explicit allow/deny.
  useEffect(() => {
    let mounted = true;
    async function loadApprovals() {
      try {
        const r = await listPendingOpsApprovals({});
        if (!mounted) return;
        setPendingApprovals(Array.isArray(r?.data) ? r.data : []);
      } catch {
        if (!mounted) return;
        setPendingApprovals([]);
      }
    }

    loadApprovals();
    const t = setInterval(loadApprovals, 30000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, [listPendingOpsApprovals]);

  async function handleSend(overrideText = null) {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;

    setInput('');
    setError(null);
    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const userMsg = {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    const todoCommand = text.match(/^\/todo\s+([\s\S]+)/i);
    if (todoCommand) {
      try {
        const title = todoCommand[1].trim();
        const dueAt = parseLooseDueAt(title);
        const r = await upsertEaTask({ title, dueAt, source: 'chat-command' });
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `**Task queued**\nI added this task${dueAt ? ' with a due reminder' : ''}.\nTask ID: ${r?.data?.taskId || 'created'}`,
          timestamp: new Date().toISOString(),
          suggestedAdvisors: [],
        }]);
      } catch (err) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `**Task create failed**\n${err?.message || 'Unknown error.'}`,
          timestamp: new Date().toISOString(),
          suggestedAdvisors: [],
        }]);
      } finally {
        setLoading(false);
        focusInput();
      }
      return;
    }

    if (/^\/tasks\b/i.test(text)) {
      try {
        const r = await listEaTasks({ includeDone: false, limit: 10 });
        const tasks = r?.data || [];
        const lines = tasks.length
          ? tasks.map((t) => `- ${t.id}: ${t.title}${t.dueAt ? ` (due ${new Date(t.dueAt).toLocaleString()})` : ''} [${t.status}]`)
          : ['- No open tasks.'];
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `**Open tasks**\n${lines.join('\n')}`,
          timestamp: new Date().toISOString(),
          suggestedAdvisors: [],
        }]);
      } catch (err) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `**Task list failed**\n${err?.message || 'Unknown error.'}`,
          timestamp: new Date().toISOString(),
          suggestedAdvisors: [],
        }]);
      } finally {
        setLoading(false);
        focusInput();
      }
      return;
    }

    const doneCommand = text.match(/^\/done\s+([\w-]+)(?:\s+([\s\S]+))?/i);
    if (doneCommand) {
      try {
        const taskId = doneCommand[1];
        const notes = doneCommand[2] || null;
        await completeEaTask({ taskId, notes });
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `**Task completed**\nI marked ${taskId} as done.`,
          timestamp: new Date().toISOString(),
          suggestedAdvisors: [],
        }]);
      } catch (err) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `**Task complete failed**\n${err?.message || 'Unknown error.'}`,
          timestamp: new Date().toISOString(),
          suggestedAdvisors: [],
        }]);
      } finally {
        setLoading(false);
        focusInput();
      }
      return;
    }

    if (looksLikeTaskRequest(text) || looksLikeProgramDiscovery(text) || looksLikeOpsRequest(text)) {
      // Fall through to eaChat — the EA has save_task, queue_desktop_action, and machine index tools
    } else {
      const runCommand = text.match(/^\/(run|do)\s+([\s\S]+)/i);
      if (runCommand) {
        // /run and /do commands go directly to executeAutomation webhook
        const task = runCommand[2].trim();
        try {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: '**Executing automation...**\nSending to the operations workflow now.',
            timestamp: new Date().toISOString(),
            suggestedAdvisors: [],
          }]);
          const result = await executeAutomation({ task, sessionId });
          const payload = result?.data?.result;
          const resultText = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: `**Automation accepted**\n${resultText || 'Workflow started.'}`,
            timestamp: new Date().toISOString(),
            suggestedAdvisors: [],
          }]);
        } catch (err) {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: `**Automation failed**\n${err?.message || 'Unknown error.'}`,
            timestamp: new Date().toISOString(),
            suggestedAdvisors: [],
          }]);
        } finally {
          setLoading(false);
          focusInput();
        }
        return;
      }
    }

    const history = messages
      .filter(m => !m.content.startsWith('Good ') && !m.content.startsWith('New session'))
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }));

    try {
      const result = await eaChat({
        message: text,
        sessionId,
        history,
        personaProfile,
        includeAdvisorVoices,
        advisorVoiceMode,
        selectedAdvisors,
      });
      const { response, sessionId: newSessionId, suggestedAdvisors } = result.data;

      if (newSessionId && !sessionId) setSessionId(newSessionId);

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: response,
        timestamp: new Date().toISOString(),
        suggestedAdvisors: suggestedAdvisors || [],
      }]);
    } catch (err) {
      console.error('EA chat error:', err);
      setError('EA is momentarily unavailable. Try again.');
      setMessages(prev => prev.slice(0, -1));
      setInput(text);
    } finally {
      setLoading(false);
      focusInput();
    }
  }

  function handleKeyDown(e) {
    // Desktop: Enter sends. Mobile: Enter adds newline (user taps send button).
    const isMobile = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleNewSession() {
    setMessages([{
      role: 'assistant',
      content: 'New session. What do you need?',
      timestamp: new Date().toISOString(),
      suggestedAdvisors: [],
    }]);
    setSessionId(null);
    setError(null);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    focusInput();
  }

  function handleToggleAutoSpeak() {
    const next = !autoSpeak;
    setAutoSpeak(next);
    if (!next) stopSpeech();
  }

  function handleMic() {
    // Stop if already listening
    if (micListening) {
      manualMicStopRef.current = true;
      recognitionRef.current?.stop();
      setMicListening(false);
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    pendingTranscriptRef.current = '';
    manualMicStopRef.current = false;

    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      pendingTranscriptRef.current = transcript;
      setInput(prev => (prev ? prev + ' ' + transcript : transcript));
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height =
          Math.min(textareaRef.current.scrollHeight, 120) + 'px';
      }
    };
    recognition.onerror = () => {
      pendingTranscriptRef.current = '';
      setMicListening(false);
    };
    recognition.onend = () => {
      const transcript = pendingTranscriptRef.current.trim();
      const wasManualStop = manualMicStopRef.current;
      pendingTranscriptRef.current = '';
      manualMicStopRef.current = false;
      setMicListening(false);
      if (transcript && !wasManualStop) {
        handleSend(transcript);
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setMicListening(true);
  }

  const containerStyle = viewportHeight > 0
    ? { ...styles.container, height: `${viewportHeight}px`, minHeight: `${viewportHeight}px` }
    : styles.container;

  return (
    <div style={containerStyle}>
      {/* Foreground notification banner */}
      <ForegroundNotification
        message={foregroundMessage}
        onDismiss={dismissForegroundMessage}
      />

      {/* Header */}
      <div
        className="ea-header safe-top"
        style={{
          ...styles.header,
          alignItems: isMobileView ? 'flex-start' : 'center',
          flexDirection: isMobileView ? 'column' : 'row',
          gap: isMobileView ? '8px' : 0,
        }}
      >
        <div>
          <div className="ea-header-title" style={styles.headerTitle}>
            Executive Assistant
          </div>
          <div className="ea-header-sub" style={styles.headerSub}>
            RMcManus Holdings LLC · Chief of Staff
            {permission === 'granted' && (
              <span style={{ color: '#2ecc71', marginLeft: '6px', fontSize: '10px' }}>
                ● reminders on
              </span>
            )}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            gap: isMobileView ? '6px' : '8px',
            alignItems: 'center',
            flexWrap: isMobileView ? 'wrap' : 'nowrap',
            width: isMobileView ? '100%' : 'auto',
          }}
        >
          <button
            onClick={handleConnectGoogle}
            disabled={googleConnecting || !gisLoaded}
            style={{
              ...styles.newBtn,
              borderColor: googleConnected ? '#1e8449' : '#7d6608',
              color: googleConnected ? '#82e0aa' : '#f9e79f',
              opacity: googleConnecting ? 0.7 : 1,
            }}
            title={googleConnected ? 'Google Calendar, Gmail & Maps connected — click to reconnect' : 'Connect Google to enable Calendar, Gmail, Maps & Calls'}
          >
            {googleConnecting ? 'Connecting…' : googleConnected ? 'Google ✓' : 'Connect Google'}
          </button>
          {!isMobileView && (
            <button
              onClick={handleToggleAutoSpeak}
              style={{
                ...styles.newBtn,
                borderColor: autoSpeak ? '#1e8449' : '#2a3a4a',
                color: autoSpeak ? '#82e0aa' : '#8899aa',
              }}
              title={autoSpeak ? 'Auto-play EA responses is on' : 'Auto-play EA responses is off'}
            >
              {autoSpeak ? 'Voice: On' : 'Voice: Off'}
            </button>
          )}
          {!isMobileView && autoSpeak && (
            <button
              onClick={() => setSpeechMode((m) => (m === 'browser' ? 'openai' : 'browser'))}
              style={{
                ...styles.newBtn,
                borderColor: speechMode === 'openai' ? '#2a5280' : '#2a3a4a',
                color: speechMode === 'openai' ? '#a0c4ff' : '#8899aa',
              }}
              title={speechMode === 'openai' ? 'OpenAI premium voice mode' : 'Browser-native voice mode'}
            >
              Engine: {speechMode === 'openai' ? 'OpenAI' : 'Browser'}
            </button>
          )}
          {!isMobileView && autoSpeak && speechMode === 'openai' && (
            <select
              value={openAiVoice}
              onChange={(e) => setOpenAiVoice(e.target.value)}
              style={{
                ...styles.newBtn,
                padding: '8px 10px',
                minWidth: '108px',
              }}
              title="OpenAI voice"
            >
              {OPENAI_VOICE_OPTIONS.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          )}
          {!isMobileView && includeAdvisorVoices && (
            <select
              value={advisorVoiceMode}
              onChange={(e) => setAdvisorVoiceMode(e.target.value)}
              style={{ ...styles.newBtn, padding: '8px 10px', minWidth: '120px' }}
              title="Advisor routing mode"
            >
              <option value="auto">Advisors: Auto</option>
              <option value="all">Advisors: All</option>
              <option value="manual">Advisors: Manual</option>
            </select>
          )}
          {!isMobileView && (
            <button
              onClick={() => setIncludeAdvisorVoices((v) => !v)}
              style={{
                ...styles.newBtn,
                borderColor: includeAdvisorVoices ? '#1a5276' : '#2a3a4a',
                color: includeAdvisorVoices ? '#5dade2' : '#8899aa',
              }}
              title={includeAdvisorVoices ? 'Advisor voices enabled' : 'Advisor voices disabled'}
            >
              Advisors: {includeAdvisorVoices ? 'On' : 'Off'}
            </button>
          )}
          <button
            className="ea-new-btn"
            onClick={handleNewSession}
            style={styles.newBtn}
          >
            + New
          </button>
          {onSignOut && (
            <button
              onClick={onSignOut}
              style={{ ...styles.newBtn, color: '#3a4a5a' }}
              title="Sign out"
            >
              ⎋
            </button>
          )}
        </div>
      </div>

      {/* Notification permission prompt */}
      {showNotifPrompt && permission !== 'granted' && permission !== 'denied' && (
        <NotificationPrompt
          onEnable={() => { setShowNotifPrompt(false); requestPermission?.(); }}
          onDismiss={() => setShowNotifPrompt(false)}
        />
      )}

      {/* Board member legend */}
      <div className="ea-advisor-bar" style={styles.advisorBar}>
        {Object.entries(ADVISOR_COLORS).map(([advisor, s]) => (
          <div key={advisor} style={styles.advisorPill}>
            <span style={{ ...styles.advisorDot, backgroundColor: s.label }} />
            <span style={{ color: '#6b7a99', fontSize: '11px', whiteSpace: 'nowrap' }}>
              {advisor} — {ADVISOR_FULL_NAMES[advisor]}
            </span>
            {includeAdvisorVoices && advisorVoiceMode === 'manual' && (
              <input
                type="checkbox"
                checked={selectedAdvisors.includes(advisor)}
                onChange={(e) => {
                  setSelectedAdvisors((prev) => {
                    if (e.target.checked) return Array.from(new Set([...prev, advisor]));
                    return prev.filter((a) => a !== advisor);
                  });
                }}
                title={`Include ${advisor}`}
              />
            )}
            {autoSpeak && speechMode === 'openai' && (
              <select
                value={voiceByBot[advisor] || 'nova'}
                onChange={(e) => setVoiceByBot((prev) => ({ ...prev, [advisor]: e.target.value }))}
                style={{ ...styles.newBtn, padding: '4px 8px', minHeight: '30px', fontSize: '11px' }}
                title={`${advisor} voice`}
              >
                {OPENAI_VOICE_OPTIONS.map((v) => (
                  <option key={`${advisor}-${v}`} value={v}>{v}</option>
                ))}
              </select>
            )}
          </div>
        ))}
        {autoSpeak && speechMode === 'openai' && (
          <div style={styles.advisorPill}>
            <span style={{ color: '#6b7a99', fontSize: '11px', whiteSpace: 'nowrap' }}>EA Voice</span>
            <select
              value={voiceByBot.EA || openAiVoice}
              onChange={(e) => setVoiceByBot((prev) => ({ ...prev, EA: e.target.value }))}
              style={{ ...styles.newBtn, padding: '4px 8px', minHeight: '30px', fontSize: '11px' }}
              title="EA voice"
            >
              {OPENAI_VOICE_OPTIONS.map((v) => (
                <option key={`EA-${v}`} value={v}>{v}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="ea-messages messages-scroll" style={styles.messagesArea}>
        {pendingApprovals.length > 0 && (
          <div style={styles.approvalPanel}>
            <div style={styles.approvalTitle}>Approval Required</div>
            {pendingApprovals.slice(0, 3).map((job) => (
              <div key={job.id} style={styles.approvalItem}>
                <div style={{ fontSize: '13px', color: '#d7e3f5', marginBottom: '6px' }}>
                  <strong>{job.projectName || 'Ops Job'}</strong> · {job.id}
                </div>
                <div style={{ fontSize: '12px', color: '#7f8ea6', marginBottom: '8px', whiteSpace: 'pre-wrap' }}>
                  {job.needsApprovalAction || job.instruction || 'Approval requested to continue this job.'}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    style={{ ...styles.newBtn, borderColor: '#1e8449', color: '#82e0aa' }}
                    onClick={async () => {
                      await decideOpsApproval({ jobId: job.id, decision: 'approve' });
                      const r = await listPendingOpsApprovals({});
                      setPendingApprovals(Array.isArray(r?.data) ? r.data : []);
                    }}
                  >
                    Allow
                  </button>
                  <button
                    style={{ ...styles.newBtn, borderColor: '#922b21', color: '#f1948a' }}
                    onClick={async () => {
                      await decideOpsApproval({ jobId: job.id, decision: 'deny' });
                      const r = await listPendingOpsApprovals({});
                      setPendingApprovals(Array.isArray(r?.data) ? r.data : []);
                    }}
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {messages.map((msg, i) => (
          <Message key={i} msg={msg} />
        ))}

        {loading && (
          <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: '20px' }}>
            <div style={styles.loadingBubble}>
              <ThinkingIndicator />
            </div>
          </div>
        )}

        {error && (
          <div style={styles.errorBanner}>{error}</div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="ea-input-area safe-bottom" style={styles.inputArea}>
        {speechSupported && (
          <button
            onClick={handleToggleAutoSpeak}
            disabled={loading}
            aria-label={autoSpeak ? 'Turn voice replies off' : 'Turn voice replies on'}
            title={autoSpeak ? 'Voice replies on' : 'Voice replies off'}
            style={{
              ...styles.sendBtn,
              backgroundColor: autoSpeak ? '#1e8449' : 'transparent',
              border: autoSpeak ? 'none' : '1px solid #2a3a4a',
              fontSize: '18px',
              opacity: loading ? 0.35 : 1,
            }}
          >
            {autoSpeak ? '🔊' : '🔈'}
          </button>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => {
            setInput(e.target.value);
            // Auto-grow (max 5 lines ~120px)
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
          }}
          onKeyDown={handleKeyDown}
          placeholder="Ask the EA anything… (/run, /todo, /tasks, /done)"
          rows={1}
          style={styles.textarea}
          disabled={loading}
        />
        {micSupported && (
          <button
            onClick={handleMic}
            disabled={loading}
            aria-label={micListening ? 'Stop recording' : 'Speak'}
            style={{
              ...styles.sendBtn,
              backgroundColor: micListening ? '#7a1f1f' : 'transparent',
              border: micListening ? 'none' : '1px solid #2a3a4a',
              fontSize: '18px',
              animation: micListening ? 'micPulse 1s ease-in-out infinite' : 'none',
              opacity: loading ? 0.35 : 1,
            }}
          >
            🎤
          </button>
        )}
        {speaking && (
          <button
            onClick={stopSpeech}
            disabled={loading}
            aria-label="Stop speech"
            style={{
              ...styles.sendBtn,
              backgroundColor: '#3a1f1f',
              border: '1px solid #7a2e2e',
              fontSize: '16px',
              opacity: loading ? 0.35 : 1,
            }}
          >
            ◼
          </button>
        )}
        <button
          className="ea-send-btn"
          onClick={handleSend}
          disabled={!input.trim() || loading}
          aria-label="Send"
          style={{
            ...styles.sendBtn,
            opacity: !input.trim() || loading ? 0.35 : 1,
          }}
        >
          {loading ? '…' : '↑'}
        </button>
      </div>

      {/* Desktop-only hint */}
      <div
        className="ea-hint"
        style={{ ...styles.hint, display: isMobileView ? 'none' : 'block' }}
      >
        Enter to send · Shift+Enter for new line
      </div>
    </div>
  );
}

// ============================================================
// STYLES
// ============================================================

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100dvh',
    minHeight: '100dvh',
    backgroundColor: '#060d18',
    color: '#e8edf5',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    position: 'relative',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 20px 12px',
    paddingTop: 'max(16px, env(safe-area-inset-top, 16px))',
    borderBottom: '1px solid #1e2a3a',
    backgroundColor: '#080f1c',
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: '18px',
    fontWeight: 700,
    color: '#f0f4ff',
    letterSpacing: '-0.3px',
  },
  headerSub: {
    fontSize: '12px',
    color: '#4a5568',
    marginTop: '2px',
    display: 'flex',
    alignItems: 'center',
  },
  newBtn: {
    padding: '8px 16px',
    minHeight: '44px',
    backgroundColor: 'transparent',
    border: '1px solid #2a3a4a',
    borderRadius: '8px',
    color: '#8899aa',
    fontSize: '13px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    WebkitAppearance: 'none',
  },
  advisorBar: {
    display: 'flex',
    gap: '16px',
    padding: '10px 28px',
    borderBottom: '1px solid #111820',
    backgroundColor: '#060d18',
    flexWrap: 'wrap',
    flexShrink: 0,
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
  },
  advisorPill: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
  },
  advisorDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  messagesArea: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '24px 28px',
    WebkitOverflowScrolling: 'touch',
    overscrollBehaviorY: 'contain',
  },
  loadingBubble: {
    padding: '10px 16px',
    backgroundColor: '#0d1220',
    border: '1px solid #1e2a3a',
    borderRadius: '18px 18px 18px 4px',
  },
  errorBanner: {
    padding: '10px 14px',
    backgroundColor: '#2c1010',
    border: '1px solid #7a2e2e',
    borderRadius: '8px',
    color: '#f1948a',
    fontSize: '13px',
    marginBottom: '12px',
  },
  approvalPanel: {
    marginBottom: '16px',
    backgroundColor: '#111a28',
    border: '1px solid #2a3a4a',
    borderRadius: '10px',
    padding: '12px',
  },
  approvalTitle: {
    fontSize: '12px',
    fontWeight: 700,
    color: '#a0c4ff',
    marginBottom: '10px',
    letterSpacing: '0.4px',
    textTransform: 'uppercase',
  },
  approvalItem: {
    padding: '10px',
    border: '1px solid #1e2a3a',
    borderRadius: '8px',
    backgroundColor: '#0d1522',
    marginBottom: '8px',
  },
  inputArea: {
    display: 'flex',
    gap: '10px',
    padding: '12px 20px',
    paddingBottom: 'max(12px, calc(8px + env(safe-area-inset-bottom, 0px)))',
    borderTop: '1px solid #1e2a3a',
    backgroundColor: '#080f1c',
    alignItems: 'flex-end',
    flexShrink: 0,
  },
  textarea: {
    flex: 1,
    backgroundColor: '#0d1824',
    border: '1px solid #2a3a4a',
    borderRadius: '12px',
    color: '#e8edf5',
    fontSize: '16px', // 16px prevents iOS auto-zoom on focus
    padding: '12px 14px',
    resize: 'none',
    outline: 'none',
    lineHeight: '1.5',
    fontFamily: 'inherit',
    maxHeight: '120px',
    overflowY: 'auto',
    WebkitAppearance: 'none',
    appearance: 'none',
  },
  sendBtn: {
    width: '46px',
    height: '46px',
    minWidth: '46px',
    backgroundColor: '#2a5280',
    border: 'none',
    borderRadius: '12px',
    color: '#fff',
    fontSize: '20px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    WebkitAppearance: 'none',
  },
  hint: {
    textAlign: 'center',
    fontSize: '11px',
    color: '#2a3a4a',
    padding: '4px 0 8px',
    backgroundColor: '#080f1c',
    flexShrink: 0,
  },
};

// Inject keyframes (runs once — safe for PWA)
if (typeof document !== 'undefined' && !document.getElementById('ea-keyframes')) {
  const styleEl = document.createElement('style');
  styleEl.id = 'ea-keyframes';
  styleEl.textContent = `
    @keyframes pulse {
      0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
      30% { opacity: 1; transform: scale(1); }
    }
    @keyframes eaSlideDown {
      from { transform: translateY(-100%); }
      to   { transform: translateY(0); }
    }
    @keyframes micPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.6; transform: scale(0.92); }
    }
    /* Hide desktop hint on mobile */
    @media (max-width: 640px) {
      .ea-hint { display: none !important; }
      .ea-advisor-bar span:last-child {
        display: none; /* hide full name, show abbrev only */
      }
    }
  `;
  document.head.appendChild(styleEl);
}
