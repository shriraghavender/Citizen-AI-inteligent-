const STORAGE_KEY = 'citizenai.locker.v1';
const SETTINGS_KEY = 'citizenai.settings.v1';
const MAX_LIBRARY_PREVIEW = 240;

const state = {
  items: [],
  messages: [],
  aiReady: false,
  model: null,
  embeddingsCache: new Map(),
  settings: {
    useAI: true,
  },
};

const stopWords = new Set([
  'the','and','for','with','this','that','from','your','you','are','was','were','have','has','had','been','will','would','could','should','about','into','over','under','again','what','which','when','where','how','who','whom','why','can','could','may','might','must','shall','to','of','in','on','at','by','a','an','or','is','it','as','be','i','me','my','we','our','us','yourself','myself','itself','they','them','their','there','here','than','then','also','not','no','yes','do','does','did','done','if','else','just','more','most','less','few','many','some','any','all','each','per','via','very'
]);

const el = {
  chatWindow: document.getElementById('chatWindow'),
  messageInput: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),
  fileInput: document.getElementById('fileInput'),
  uploadZone: document.getElementById('uploadZone'),
  summaryGrid: document.getElementById('summaryGrid'),
  libraryList: document.getElementById('libraryList'),
  librarySearch: document.getElementById('librarySearch'),
  libraryFilter: document.getElementById('libraryFilter'),
  typeChart: document.getElementById('typeChart'),
  themeBars: document.getElementById('themeBars'),
  timeline: document.getElementById('timeline'),
  clarityScore: document.getElementById('clarityScore'),
  scoreRing: document.getElementById('scoreRing'),
  miniStats: document.getElementById('miniStats'),
  libraryCountPill: document.getElementById('libraryCountPill'),
  aiStatusDot: document.getElementById('aiStatusDot'),
  aiStatusText: document.getElementById('aiStatusText'),
  exportBtn: document.getElementById('exportBtn'),
  clearBtn: document.getElementById('clearBtn'),
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      state.items = Array.isArray(saved.items) ? saved.items : [];
      state.messages = Array.isArray(saved.messages) ? saved.messages : [];
    }
    if (settings && typeof settings === 'object') {
      state.settings = { ...state.settings, ...settings };
    }
  } catch {
    // ignore corrupt storage
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: state.items, messages: state.messages }));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function escapeHTML(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(ts) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ts));
}

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/[#>*_~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(text) {
  const clean = stripMarkdown(text);
  return clean.match(/[^.!?\n]+[.!?]?/g)?.map(s => s.trim()).filter(Boolean) || [clean];
}

function tokenize(text) {
  return stripMarkdown(text)
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t && !stopWords.has(t) && t.length > 1);
}

function countKeywords() {
  const freq = new Map();
  for (const item of state.items) {
    for (const word of tokenize(item.text)) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word, count]) => ({ word, count }));
}

function extractFacts(text) {
  const facts = [];
  const patterns = [
    { label: 'Email', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
    { label: 'Phone', regex: /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{4}\b/g },
    { label: 'URL', regex: /https?:\/\/[^\s)]+/gi },
    { label: 'Date', regex: /\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/gi },
    { label: 'Money', regex: /(?:₹|rs\.?|inr|usd|\$)\s?\d[\d,]*(?:\.\d+)?/gi },
    { label: 'ID', regex: /\b[A-Z0-9-]{6,}\b/g },
  ];

  for (const { label, regex } of patterns) {
    const matches = [...text.matchAll(regex)].map(m => m[0]);
    if (matches.length) {
      facts.push(...matches.map(value => ({ label, value })));
    }
  }

  const nameMatches = [
    /\bmy name is\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})/i,
    /\bi am\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})/i,
    /\bname[:\-]\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})/i,
  ];
  for (const regex of nameMatches) {
    const match = text.match(regex);
    if (match?.[1]) facts.push({ label: 'Name', value: match[1].trim() });
  }

  const locationMatches = [
    /\bI live in\s+([^\n.,;]{2,60})/i,
    /\baddress[:\-]\s*([^\n]{2,80})/i,
    /\bcity[:\-]\s*([^\n]{2,40})/i,
  ];
  for (const regex of locationMatches) {
    const match = text.match(regex);
    if (match?.[1]) facts.push({ label: 'Location', value: match[1].trim() });
  }

  return dedupeFacts(facts);
}

function dedupeFacts(facts) {
  const seen = new Set();
  return facts.filter(f => {
    const key = `${f.label}:${f.value}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createItem({ type, title, sourceName, text, mimeType = '', size = 0 }) {
  const item = {
    id: uid(),
    type,
    title,
    sourceName,
    mimeType,
    size,
    text: text.trim(),
    facts: extractFacts(text),
    keywords: tokenize(text),
    createdAt: Date.now(),
  };
  state.items.unshift(item);
  return item;
}

function addMessage(role, text, meta = '') {
  const message = {
    id: uid(),
    role,
    text,
    meta,
    createdAt: Date.now(),
  };
  state.messages.push(message);
  renderMessage(message);
  saveState();
  return message;
}

function renderMessage(message) {
  const template = document.getElementById('chatMessageTemplate');
  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add(message.role === 'user' ? 'user' : 'assistant');
  node.querySelector('.avatar').textContent = message.role === 'user' ? 'You' : 'CA';
  node.querySelector('.message-meta').textContent = message.meta || (message.role === 'assistant' ? 'CitizenAI' : 'You');
  node.querySelector('.message-text').innerHTML = formatMessageHTML(message.text);
  el.chatWindow.appendChild(node);
  el.chatWindow.scrollTop = el.chatWindow.scrollHeight;
}

function formatMessageHTML(text) {
  const safe = escapeHTML(text);
  const linked = safe.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  return linked.replace(/\n/g, '<br>');
}

function setStatus(ready, text) {
  el.aiStatusText.textContent = text;
  el.aiStatusDot.style.background = ready ? 'var(--good)' : 'var(--warn)';
}

async function initModel() {
  if (!state.settings.useAI) {
    setStatus(false, 'Rule-based mode');
    return;
  }

  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/transformers.min.js');
    const { pipeline, env } = mod;
    env.allowRemoteModels = true;
    env.backends.onnx.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
    state.model = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    state.aiReady = true;
    setStatus(true, 'Browser model loaded');
  } catch (error) {
    console.warn('Model load failed, using fallback mode.', error);
    state.model = null;
    state.aiReady = false;
    setStatus(false, 'Rule-based fallback');
  }
}

async function embedText(text) {
  if (!state.model) return null;
  if (state.embeddingsCache.has(text)) return state.embeddingsCache.get(text);
  const output = await state.model(text, { pooling: 'mean', normalize: true });
  const vector = Array.from(output.data || output);
  state.embeddingsCache.set(text, vector);
  return vector;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function scoreOverlap(queryTokens, itemText) {
  const itemTokens = tokenize(itemText);
  const itemSet = new Set(itemTokens);
  let score = 0;
  for (const token of queryTokens) {
    if (itemSet.has(token)) score += 2;
    if (itemText.toLowerCase().includes(token)) score += 1;
  }
  return score;
}

async function searchLibrary(query, limit = 5) {
  const qTokens = tokenize(query);
  const qEmbedding = state.model ? await embedText(query) : null;

  const scored = await Promise.all(state.items.map(async item => {
    const overlap = scoreOverlap(qTokens, item.text + ' ' + item.title + ' ' + item.sourceName);
    const factsBonus = item.facts.reduce((sum, fact) => {
      const val = fact.value.toLowerCase();
      return sum + (query.toLowerCase().includes(val) ? 5 : 0);
    }, 0);

    let semantic = 0;
    if (qEmbedding) {
      const textForEmbedding = item.text.slice(0, 1200);
      const itemEmbedding = await embedText(textForEmbedding);
      semantic = itemEmbedding ? cosineSimilarity(qEmbedding, itemEmbedding) * 12 : 0;
    }

    const recency = Math.max(0, 2 - (Date.now() - item.createdAt) / (1000 * 60 * 60 * 24 * 3));
    return { item, score: overlap + factsBonus + semantic + recency };
  }));

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

function directFactAnswer(query) {
  const q = query.toLowerCase();
  const askedAbout = [];
  if (/(my|the) name/.test(q)) askedAbout.push('Name');
  if (/email|mail/.test(q)) askedAbout.push('Email');
  if (/phone|mobile|contact/.test(q)) askedAbout.push('Phone');
  if (/address|location|city/.test(q)) askedAbout.push('Location');
  if (/date|when/.test(q)) askedAbout.push('Date');
  if (/id|reference|number/.test(q)) askedAbout.push('ID');
  if (/url|link|website/.test(q)) askedAbout.push('URL');
  if (/money|amount|salary|income/.test(q)) askedAbout.push('Money');

  const matches = [];
  for (const item of state.items) {
    for (const fact of item.facts) {
      if (askedAbout.includes(fact.label) || q.includes(fact.value.toLowerCase())) {
        matches.push({ item, fact });
      }
    }
  }

  if (!matches.length) return null;

  const grouped = new Map();
  for (const match of matches) {
    const list = grouped.get(match.fact.label) || [];
    list.push(match.fact.value);
    grouped.set(match.fact.label, list);
  }

  const lines = [];
  for (const [label, values] of grouped.entries()) {
    lines.push(`${label}: ${[...new Set(values)].slice(0, 5).join(', ')}`);
  }

  return lines.join('\n');
}

async function answerQuestion(query) {
  const lower = query.toLowerCase();

  const direct = directFactAnswer(query);
  if (direct) {
    return `I found these direct matches in your stored data:\n\n${direct}`;
  }

  if (/summary|summarize|overview|what do you know|tell me everything/.test(lower)) {
    const summary = buildSummaryText();
    return `Here is a clean summary of your locker:\n\n${summary}`;
  }

  if (/latest|recent|newest|last/.test(lower)) {
    const latest = [...state.items].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest) {
      return `The most recent item is “${latest.title}”. I stored it on ${formatTime(latest.createdAt)} and it contains ${latest.facts.length} extracted fact(s).`;
    }
  }

  const ranked = await searchLibrary(query, 3);
  if (ranked.length && ranked[0].score > 2.2) {
    const best = ranked[0].item;
    const sentences = splitSentences(best.text).slice(0, 3);
    const preview = sentences.join(' ');
    const facts = best.facts.slice(0, 4).map(f => `${f.label}: ${f.value}`).join('\n');
    return `This looks relevant from “${best.title}”.\n\n${preview}${facts ? `\n\nStored facts:\n${facts}` : ''}`;
  }

  if (state.items.length) {
    const top = ranked.map(x => `• ${x.item.title} (${x.item.sourceName})`).join('\n');
    return `I could not find a confident exact answer, but these stored items look closest:\n\n${top || 'No strong matches found.'}\n\nTry using a more specific phrase, or add the detail as text or a file.`;
  }

  return 'The locker is empty right now. Add some text or files, then I can answer questions from that data.';
}

function buildSummaryText() {
  const total = state.items.length;
  const files = state.items.filter(i => i.type === 'file').length;
  const messages = state.items.filter(i => i.type === 'message').length;
  const facts = state.items.reduce((sum, item) => sum + item.facts.length, 0);
  const keywords = countKeywords().slice(0, 5).map(k => k.word).join(', ') || 'none yet';
  return [
    `${total} stored item(s)`,
    `${files} file(s) and ${messages} text message(s)`,
    `${facts} extracted fact(s)`,
    `Top keywords: ${keywords}`,
  ].join('\n');
}

function renderSummary() {
  const total = state.items.length;
  const fileCount = state.items.filter(i => i.type === 'file').length;
  const messageCount = state.items.filter(i => i.type === 'message').length;
  const factCount = state.items.reduce((sum, item) => sum + item.facts.length, 0);
  const topKeywords = countKeywords().slice(0, 3);
  const freshness = total ? formatTime(Math.max(...state.items.map(i => i.createdAt))) : 'No data yet';

  el.summaryGrid.innerHTML = [
    { kpi: total, label: 'Stored items', sub: `CitizenAI is holding ${messageCount} message(s) and ${fileCount} file(s).` },
    { kpi: factCount, label: 'Extracted facts', sub: 'Emails, phones, dates, IDs, money and names are detected automatically.' },
    { kpi: topKeywords[0]?.word || '—', label: 'Top theme', sub: topKeywords.map(k => `${k.word} × ${k.count}`).join(' • ') || 'Add more data to surface themes.' },
    { kpi: total ? 'Live' : 'Idle', label: 'Freshness', sub: `Last update: ${freshness}` },
  ].map(card => `
    <div class="summary-card">
      <div class="kpi">${escapeHTML(card.kpi)}</div>
      <div class="label">${escapeHTML(card.label)}</div>
      <div class="sub">${escapeHTML(card.sub)}</div>
    </div>
  `).join('');

  el.libraryCountPill.textContent = `${total} item${total === 1 ? '' : 's'} stored`;
}

function renderMiniStats() {
  const total = state.items.length;
  const facts = state.items.reduce((sum, item) => sum + item.facts.length, 0);
  const files = state.items.filter(i => i.type === 'file').length;
  const messages = state.items.filter(i => i.type === 'message').length;

  el.miniStats.innerHTML = `
    <div class="stat-tile"><div class="value">${total}</div><div class="label">Items stored</div></div>
    <div class="stat-tile"><div class="value">${facts}</div><div class="label">Facts extracted</div></div>
    <div class="stat-tile"><div class="value">${files}</div><div class="label">Files</div></div>
    <div class="stat-tile"><div class="value">${messages}</div><div class="label">Messages</div></div>
  `;
}

function renderLibrary() {
  const search = el.librarySearch.value.trim().toLowerCase();
  const filter = el.libraryFilter.value;

  const filtered = state.items.filter(item => {
    const matchesSearch = !search || [item.title, item.text, item.sourceName, item.facts.map(f => `${f.label}:${f.value}`).join(' ')].join(' ').toLowerCase().includes(search);
    const matchesFilter = filter === 'all' || item.type === filter;
    return matchesSearch && matchesFilter;
  });

  if (!filtered.length) {
    el.libraryList.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <div>
          <div class="badge">No matching data</div>
          <h3 style="margin:12px 0 6px;">Nothing found in the locker</h3>
          <p style="margin:0;">Add a message or upload a file to populate the data library.</p>
        </div>
      </div>
    `;
    return;
  }

  el.libraryList.innerHTML = filtered.map(item => {
    const preview = item.text.length > MAX_LIBRARY_PREVIEW ? `${item.text.slice(0, MAX_LIBRARY_PREVIEW)}…` : item.text;
    const tags = item.facts.slice(0, 5).map(f => `${f.label}: ${f.value}`);
    return `
      <article class="library-card">
        <div class="library-top">
          <div>
            <div class="library-type">${escapeHTML(item.type)}</div>
            <h3>${escapeHTML(item.title)}</h3>
          </div>
          <div class="badge">${escapeHTML(formatTime(item.createdAt))}</div>
        </div>
        <p>${escapeHTML(preview)}</p>
        <div class="tag-row">
          ${tags.map(tag => `<span class="tag">${escapeHTML(tag)}</span>`).join('') || '<span class="tag">No extracted facts</span>'}
        </div>
        <div class="meta-row">
          <span>${escapeHTML(item.sourceName)}</span>
          <span>${item.text.length} chars</span>
        </div>
      </article>
    `;
  }).join('');
}

function renderTypeChart() {
  const files = state.items.filter(i => i.type === 'file').length;
  const messages = state.items.filter(i => i.type === 'message').length;
  const total = Math.max(files + messages, 1);
  const filePct = files / total;
  const msgPct = messages / total;

  const cx = 120, cy = 110, r = 70;
  const fileAngle = filePct * Math.PI * 2;
  const msgAngle = msgPct * Math.PI * 2;
  const fileDash = `${fileAngle * r} ${Math.PI * 2 * r}`;
  const msgDash = `${msgAngle * r} ${Math.PI * 2 * r}`;

  el.typeChart.innerHTML = `
    <defs>
      <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#7cc4ff" />
        <stop offset="100%" stop-color="#8f7bff" />
      </linearGradient>
      <linearGradient id="g2" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#72e0a0" />
        <stop offset="100%" stop-color="#7cc4ff" />
      </linearGradient>
    </defs>
    <g transform="translate(${cx},${cy}) rotate(-90)">
      <circle r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="22" />
      <circle r="${r}" fill="none" stroke="url(#g1)" stroke-width="22" stroke-linecap="round"
        stroke-dasharray="${fileDash}" stroke-dashoffset="0" />
      <circle r="${r}" fill="none" stroke="url(#g2)" stroke-width="22" stroke-linecap="round"
        stroke-dasharray="${msgDash}" stroke-dashoffset="${-fileAngle * r}" />
    </g>
    <g transform="translate(190,72)">
      <rect width="12" height="12" rx="4" fill="#7cc4ff" />
      <text x="20" y="11" fill="#dce8ff" font-size="14">Files: ${files}</text>
      <rect y="28" width="12" height="12" rx="4" fill="#72e0a0" />
      <text x="20" y="39" fill="#dce8ff" font-size="14">Messages: ${messages}</text>
      <text x="-170" y="112" fill="#a7b4cb" font-size="12">Total items: ${total}</text>
    </g>
  `;
}

function renderThemeBars() {
  const themes = countKeywords().slice(0, 6);
  const max = Math.max(...themes.map(t => t.count), 1);
  if (!themes.length) {
    el.themeBars.innerHTML = '<div class="empty-state" style="min-height:180px;">Add data to reveal themes.</div>';
    return;
  }
  el.themeBars.innerHTML = themes.map(theme => `
    <div class="bar-row">
      <div class="bar-label">${escapeHTML(theme.word)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(theme.count / max) * 100}%"></div></div>
      <div class="bar-value">${theme.count}</div>
    </div>
  `).join('');
}

function renderTimeline() {
  const items = [...state.items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
  if (!items.length) {
    el.timeline.innerHTML = '<div class="empty-state" style="min-height:180px;">No activity yet.</div>';
    return;
  }
  el.timeline.innerHTML = items.map(item => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="timeline-content">
        <div class="timeline-title">${escapeHTML(item.title)}</div>
        <div class="timeline-sub">${escapeHTML(formatTime(item.createdAt))} • ${escapeHTML(item.type)} • ${item.facts.length} fact(s)</div>
      </div>
    </div>
  `).join('');
}

function renderClarityScore() {
  const total = state.items.length;
  const facts = state.items.reduce((sum, item) => sum + item.facts.length, 0);
  const keywords = countKeywords().length;
  const score = total ? Math.min(100, Math.round((facts * 8) + (keywords * 5) + (Math.min(total, 10) * 3))) : 0;
  el.clarityScore.textContent = score;
  el.scoreRing.style.background = `conic-gradient(var(--good) 0deg, var(--accent) ${Math.max(20, score * 3.2)}deg, rgba(255,255,255,0.08) ${Math.max(20, score * 3.2)}deg 360deg)`;
}

function renderAll() {
  renderSummary();
  renderMiniStats();
  renderLibrary();
  renderTypeChart();
  renderThemeBars();
  renderTimeline();
  renderClarityScore();
}

function restoreChat() {
  el.chatWindow.innerHTML = '';
  if (!state.messages.length) {
    renderMessage({ role: 'assistant', text: 'Welcome to CitizenAI. Add your personal data through text or files, then ask me anything about what is stored here.', meta: 'CitizenAI' });
    return;
  }
  for (const message of state.messages) renderMessage(message);
}

async function handleSend() {
  const text = el.messageInput.value.trim();
  if (!text) return;

  el.messageInput.value = '';
  addMessage('user', text, 'You');

  if (looksLikeStorageText(text)) {
    createItem({ type: 'message', title: summarizeText(text), sourceName: 'Chat message', text });
    saveState();
    renderAll();
  }

  const thinking = addMessage('assistant', 'Thinking…', 'CitizenAI');
  const reply = await answerQuestion(text);
  thinking.text = reply;
  thinking.meta = state.aiReady ? 'CitizenAI • browser model + rules' : 'CitizenAI • rules only';
  const lastNode = el.chatWindow.lastElementChild;
  if (lastNode) {
    lastNode.querySelector('.message-meta').textContent = thinking.meta;
    lastNode.querySelector('.message-text').innerHTML = formatMessageHTML(reply);
  }
  state.messages[state.messages.length - 1] = thinking;
  saveState();
  renderAll();
}

function looksLikeStorageText(text) {
  const q = text.toLowerCase();
  return /(remember|store|save|note|my name is|i am|email|phone|address|id|date|details|profile|information)/.test(q) && text.length > 18;
}

function summarizeText(text) {
  const first = splitSentences(text)[0] || text;
  return first.length > 54 ? `${first.slice(0, 54)}…` : first;
}

async function handleFileSelection(files) {
  const validFiles = [...files];
  if (!validFiles.length) return;

  for (const file of validFiles) {
    const text = await readFileAsText(file);
    const title = file.name.replace(/\.[^.]+$/, '') || file.name;
    createItem({
      type: 'file',
      title,
      sourceName: file.name,
      text,
      mimeType: file.type,
      size: file.size,
    });
  }

  saveState();
  renderAll();
  addMessage('assistant', `I stored ${validFiles.length} file(s). You can now ask questions about the data inside them.`, 'CitizenAI');
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function exportData() {
  const data = {
    exportedAt: new Date().toISOString(),
    items: state.items,
    messages: state.messages,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'citizenai-locker-export.json';
  a.click();
  URL.revokeObjectURL(url);
}

function clearLocker() {
  if (!confirm('Clear all stored data and chat history from this device?')) return;
  state.items = [];
  state.messages = [];
  saveState();
  restoreChat();
  renderAll();
}

function setupTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  const panels = [...document.querySelectorAll('.panel')];
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
    });
  });
}

function setupEvents() {
  el.sendBtn.addEventListener('click', handleSend);
  el.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  el.fileInput.addEventListener('change', async () => {
    await handleFileSelection(el.fileInput.files || []);
    el.fileInput.value = '';
  });

  el.librarySearch.addEventListener('input', renderLibrary);
  el.libraryFilter.addEventListener('change', renderLibrary);
  el.exportBtn.addEventListener('click', exportData);
  el.clearBtn.addEventListener('click', clearLocker);

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      el.messageInput.value = chip.dataset.prompt || chip.textContent.trim();
      el.messageInput.focus();
    });
  });

  el.uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.uploadZone.style.borderColor = 'rgba(114,224,160,0.55)';
  });
  el.uploadZone.addEventListener('dragleave', () => {
    el.uploadZone.style.borderColor = 'rgba(124,196,255,0.28)';
  });
  el.uploadZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.uploadZone.style.borderColor = 'rgba(124,196,255,0.28)';
    if (e.dataTransfer.files?.length) {
      await handleFileSelection(e.dataTransfer.files);
    }
  });
}

function boot() {
  loadState();
  setupTabs();
  setupEvents();
  restoreChat();
  renderAll();
  initModel().then(() => {
    renderAll();
  });
}

boot();
