function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function collectHelpLinks() {
  const links = Array.from(document.querySelectorAll('a[href]'));
  const helpy = links.filter((a) => {
    const t = normalize(a.textContent).toLowerCase();
    const href = (a.getAttribute('href') || '').toLowerCase();
    return t.includes('help') || t.includes('support') || t.includes('docs') || href.includes('help') || href.includes('support') || href.includes('docs');
  });
  return helpy.slice(0, 10).map((a) => `${normalize(a.textContent) || '(untitled)'} -> ${a.href}`);
}

function collectHeadings() {
  const nodes = Array.from(document.querySelectorAll('h1, h2, h3'));
  return nodes.map((n) => normalize(n.textContent)).filter(Boolean).slice(0, 12);
}

function findPrimaryAction() {
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
  const scored = candidates
    .map((el) => {
      const txt = normalize(el.textContent || el.value || '');
      const lowered = txt.toLowerCase();
      let score = 0;
      if (!txt) return null;
      if (el.matches('button[type="submit"], input[type="submit"]')) score += 3;
      if (lowered.includes('continue') || lowered.includes('submit') || lowered.includes('save') || lowered.includes('send') || lowered.includes('next') || lowered.includes('book')) score += 2;
      const rect = el.getBoundingClientRect();
      if (rect.top >= 0 && rect.top < window.innerHeight * 0.7) score += 1;
      return { txt, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.txt || '';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'EA_SCRAPE_PAGE') return;

  sendResponse({
    url: window.location.href,
    title: document.title || '',
    primaryAction: findPrimaryAction(),
    helpLinks: collectHelpLinks(),
    headings: collectHeadings(),
  });
});
