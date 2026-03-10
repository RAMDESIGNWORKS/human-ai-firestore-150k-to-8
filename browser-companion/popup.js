const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const noteEl = document.getElementById('note');
const analyzeBtn = document.getElementById('analyzeBtn');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#f29da0' : '#8fa4c7';
}

function renderGuidance(guidance) {
  if (!guidance) return 'No guidance returned.';
  const lines = [guidance.summary || 'Guidance ready.'];
  if (Array.isArray(guidance.steps)) {
    guidance.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  if (guidance.caution) {
    lines.push(`\nNote: ${guidance.caution}`);
  }
  return lines.join('\n');
}

async function getSettings() {
  return chrome.storage.sync.get({
    endpointUrl: '',
    companionToken: '',
    ownerId: '',
  });
}

async function getPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: 'EA_SCRAPE_PAGE' }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (!response) {
        reject(new Error('No page context returned.'));
        return;
      }
      resolve(response);
    });
  });
}

async function analyzePage() {
  try {
    setStatus('Collecting page context...');
    resultEl.textContent = '';

    const settings = await getSettings();
    if (!settings.endpointUrl || !settings.companionToken || !settings.ownerId) {
      throw new Error('Set endpoint URL, token, and owner ID in Settings first.');
    }

    const page = await getPageContext();
    setStatus('Requesting guidance from EA...');

    const payload = {
      ownerId: settings.ownerId,
      ...page,
      note: noteEl.value.trim() || null,
    };

    const resp = await fetch(settings.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-companion-token': settings.companionToken,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data?.error || `HTTP ${resp.status}`);
    }

    setStatus('Guidance received.');
    resultEl.textContent = renderGuidance(data.guidance);
  } catch (err) {
    setStatus(err.message || 'Failed to analyze page.', true);
  }
}

analyzeBtn.addEventListener('click', analyzePage);
