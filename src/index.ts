export { IncidentAgent } from "./agent";
export { IncidentMemory } from "./memory";
export { RemediationWorkflow } from "./workflow";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── CORS for dev ────────────────────────────────────────────────────
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Upgrade, Connection",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ── /api/incident/:id/ws  — WebSocket for incident chat ────────────
    const wsMatch = url.pathname.match(/^\/api\/incident\/([^/]+)\/ws$/);
    if (wsMatch) {
      const incidentId = wsMatch[1];
      const stub = env.INCIDENT_AGENT.get(env.INCIDENT_AGENT.idFromName(incidentId));
      return stub.fetch(request);
    }

    // ── /api/incident/:id/state  — REST state fetch ─────────────────────
    const stateMatch = url.pathname.match(/^\/api\/incident\/([^/]+)\/state$/);
    if (stateMatch) {
      const stub = env.INCIDENT_AGENT.get(
        env.INCIDENT_AGENT.idFromName(stateMatch[1])
      );
      const res = await stub.fetch(
        new Request("https://internal/state", { method: "GET" })
      );
      return new Response(await res.text(), {
        status: res.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── /api/incidents/seed  — load demo incidents into memory (dev/demo) ─
    if (url.pathname === "/api/incidents/seed" && request.method === "POST") {
      const body = await request.json<{
        id: string; title: string; severity: string; description: string;
        rootCause: string; resolution: string; timestamp: number; tags: string[];
      }>();
      const memoryId = env.INCIDENT_MEMORY.idFromName("global");
      const stub = env.INCIDENT_MEMORY.get(memoryId);
      const res = await stub.fetch(
        new Request("https://internal/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      );
      return new Response(await res.text(), {
        status: res.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── /api/incidents  — list past incidents from memory ──────────────
    if (url.pathname === "/api/incidents" && request.method === "GET") {
      const memoryId = env.INCIDENT_MEMORY.idFromName("global");
      const stub = env.INCIDENT_MEMORY.get(memoryId);
      const res = await stub.fetch("https://internal/list");
      return new Response(await res.text(), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Serve static UI (Cloudflare Pages / Assets) ─────────────────────
    return new Response(getHTML(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CF Incident Responder</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --border: #30363d;
      --accent: #f6821f;
      --accent2: #fbad41;
      --text: #e6edf3;
      --muted: #8b949e;
      --sev-p1: #f85149;
      --sev-p2: #e3b341;
      --sev-p3: #3fb950;
      --sev-p4: #58a6ff;
      --radius: 8px;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 12px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    header .logo {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
    }
    header h1 { font-size: 16px; font-weight: 600; }
    header .subtitle { font-size: 12px; color: var(--muted); margin-left: auto; }

    .app { display: flex; flex: 1; overflow: hidden; }

    /* Sidebar */
    .sidebar {
      width: 280px;
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .sidebar-header {
      padding: 16px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .new-incident-btn {
      margin: 12px;
      padding: 8px 12px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: var(--radius);
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      width: calc(100% - 24px);
      transition: opacity 0.15s;
    }
    .new-incident-btn:hover { opacity: 0.85; }
    .incident-list { flex: 1; overflow-y: auto; padding: 8px; }
    .incident-item {
      padding: 10px 12px;
      border-radius: var(--radius);
      cursor: pointer;
      margin-bottom: 4px;
      border: 1px solid transparent;
      transition: all 0.15s;
    }
    .incident-item:hover { background: #1c2128; border-color: var(--border); }
    .incident-item.active { background: #1c2128; border-color: var(--accent); }
    .incident-item .inc-title { font-size: 13px; font-weight: 500; }
    .incident-item .inc-meta {
      font-size: 11px; color: var(--muted); margin-top: 2px;
      display: flex; gap: 8px; align-items: center;
    }
    .sev-badge {
      font-size: 10px; font-weight: 700;
      padding: 1px 5px; border-radius: 4px;
    }
    .sev-p1 { background: #3d1515; color: var(--sev-p1); }
    .sev-p2 { background: #3d2e0a; color: var(--sev-p2); }
    .sev-p3 { background: #0d2b18; color: var(--sev-p3); }
    .sev-p4 { background: #0d1f3d; color: var(--sev-p4); }

    /* Main panel */
    .main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .incident-bar {
      padding: 12px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 52px;
    }
    .incident-bar .inc-name { font-weight: 600; font-size: 15px; }
    .status-badge {
      font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px;
    }
    .status-open { background: #3d1515; color: var(--sev-p1); }
    .status-investigating { background: #3d2e0a; color: var(--sev-p2); }
    .status-resolved { background: #0d2b18; color: var(--sev-p3); }
    .workflow-indicator {
      margin-left: auto;
      font-size: 12px;
      color: var(--muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .spinner {
      width: 12px; height: 12px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Chat */
    .chat { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
    .msg { display: flex; gap: 10px; max-width: 820px; }
    .msg.user { align-self: flex-end; flex-direction: row-reverse; }
    .msg-avatar {
      width: 32px; height: 32px; border-radius: 50%;
      flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      font-size: 14px;
    }
    .msg.assistant .msg-avatar { background: linear-gradient(135deg, var(--accent), var(--accent2)); }
    .msg.user .msg-avatar { background: #21262d; }
    .msg-body {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px 14px;
      font-size: 13.5px;
      line-height: 1.65;
      white-space: pre-wrap;
    }
    .msg.user .msg-body { background: #1a2035; border-color: #264080; }
    .msg-body h2, .msg-body h3 { margin: 10px 0 4px; }
    .msg-body code { background: #21262d; padding: 1px 4px; border-radius: 3px; font-size: 12px; }

    /* Input */
    .chat-input-wrap {
      padding: 12px 20px 16px;
      border-top: 1px solid var(--border);
      display: flex;
      gap: 8px;
    }
    .chat-input {
      flex: 1;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      padding: 9px 14px;
      font-size: 14px;
      resize: none;
      height: 42px;
      font-family: inherit;
      transition: border-color 0.15s;
    }
    .chat-input:focus { outline: none; border-color: var(--accent); }
    .send-btn {
      background: var(--accent);
      border: none;
      border-radius: var(--radius);
      color: #fff;
      padding: 0 16px;
      cursor: pointer;
      font-size: 16px;
      transition: opacity 0.15s;
    }
    .send-btn:hover { opacity: 0.85; }
    .send-btn:disabled { opacity: 0.4; cursor: default; }
    .resolve-btn {
      background: #0d2b18;
      border: 1px solid var(--sev-p3);
      border-radius: var(--radius);
      color: var(--sev-p3);
      padding: 0 12px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }

    /* Modal */
    .modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.7);
      display: flex; align-items: center; justify-content: center;
      z-index: 100;
    }
    .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 28px; width: 460px; }
    .modal h2 { font-size: 18px; margin-bottom: 20px; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; }
    .form-group input, .form-group textarea, .form-group select {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      padding: 9px 12px;
      font-size: 14px;
      font-family: inherit;
    }
    .form-group textarea { height: 90px; resize: vertical; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
    .btn-cancel {
      background: transparent; border: 1px solid var(--border);
      color: var(--muted); border-radius: var(--radius); padding: 8px 16px; cursor: pointer;
    }
    .btn-submit {
      background: var(--accent); border: none;
      color: #fff; border-radius: var(--radius); padding: 8px 20px;
      cursor: pointer; font-weight: 600;
    }

    .empty-state {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      color: var(--muted); gap: 12px;
    }
    .empty-state .icon { font-size: 48px; }
    .empty-state p { font-size: 14px; }

    .msg-body p { margin: 0 0 6px; }
    .msg-body p:last-child { margin-bottom: 0; }
    .msg-body h2, .msg-body h3, .msg-body h4 { margin: 10px 0 4px; font-size: 13px; color: var(--text); }
    .msg-body li { display: list-item; margin: 2px 0 2px 16px; }
    .msg-body code { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; font-size: 12px; font-family: monospace; }
    .msg-body strong { color: var(--text); }

    .file-upload-label {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      background: var(--bg);
      border: 1px dashed var(--border);
      border-radius: var(--radius);
      cursor: pointer;
      font-size: 13px;
      color: var(--muted);
      transition: border-color 0.15s, color 0.15s;
      width: 100%;
    }
    .file-upload-label:hover { border-color: var(--accent); color: var(--text); }
    .file-upload-label.has-file { border-color: var(--sev-p3); color: var(--sev-p3); }
    .file-upload-label input[type=file] { display: none; }
    .file-preview {
      margin-top: 6px; padding: 6px 10px;
      background: #0d1f1a; border: 1px solid var(--sev-p3);
      border-radius: var(--radius); font-size: 11px;
      color: var(--sev-p3); font-family: monospace;
      max-height: 60px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; display: none;
    }

        .typing-dot {
      display: inline-block; animation: blink 1s infinite;
    }
    @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
  </style>
</head>
<body>
<header>
  <div class="logo">🔥</div>
  <h1>Incident Responder</h1>
  <span class="subtitle">Powered by Llama 3.3 · Cloudflare Workers AI</span>
</header>

<div class="app">
  <div class="sidebar">
    <div class="sidebar-header">Active Incidents</div>
    <button class="new-incident-btn">+ New Incident</button>
    <div class="incident-list" id="incidentList"></div>
  </div>

  <div class="main">
    <div id="incidentBar" class="incident-bar">
      <span style="color:var(--muted);font-size:13px;">No incident selected</span>
    </div>
    <div id="chat" class="chat">
      <div class="empty-state">
        <div class="icon">🛡️</div>
        <p>Open a new incident to begin AI-assisted triage</p>
      </div>
    </div>
    <div class="chat-input-wrap" id="inputWrap" style="display:none">
      <textarea class="chat-input" id="chatInput" placeholder="Ask about this incident…" rows="1"></textarea>
      <button class="resolve-btn" onclick="resolveIncident()" title="Mark as resolved">✓ Resolve</button>
      <button class="send-btn" id="sendBtn" onclick="sendMessage()">↑</button>
    </div>
  </div>
</div>

<!-- New Incident Modal -->
<div class="modal-overlay" id="modal" style="display:none">
  <div class="modal">
    <h2>🚨 Open New Incident</h2>
    <div class="form-group">
      <label>Title</label>
      <input id="incTitle" type="text" placeholder="e.g. Database connection pool exhausted" />
    </div>
    <div class="form-group">
      <label>Severity</label>
      <select id="incSeverity">
        <option value="P1">P1 — Critical</option>
        <option value="P2" selected>P2 — High</option>
        <option value="P3">P3 — Medium</option>
        <option value="P4">P4 — Low</option>
      </select>
    </div>
    <div class="form-group">
      <label>Description</label>
      <textarea id="incDesc" placeholder="Describe the symptoms, affected services, and any context…"></textarea>
    </div>
    <div class="form-group">
      <label>Attach Context (optional)</label>
      <label class="file-upload-label" id="fileLabel">
        <input type="file" id="incFile" accept=".log,.txt,.json,.csv" onchange="handleFileSelect(this)" />
        <span id="fileLabelText">📎 Attach logs, metrics, or error output (.log .txt .json)</span>
      </label>
      <div class="file-preview" id="filePreview"></div>
    </div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-submit" onclick="createIncident()">Open Incident</button>
    </div>
  </div>
</div>

<script>
  let ws = null;
  let currentIncidentId = null;
  let incidents = {};
  let isTyping = false;
  let streamBuffer = '';

  function openModal() { document.getElementById('modal').style.display = 'flex'; }
  function closeModal() { document.getElementById('modal').style.display = 'none'; }

  let attachedFileContent = null;
  let attachedFileName = null;

  function handleFileSelect(input) {
    const file = input.files[0];
    if (!file) return;
    attachedFileName = file.name;
    const reader = new FileReader();
    reader.onload = (e) => {
      // Truncate to 3000 chars to stay within context limits
      attachedFileContent = e.target.result.slice(0, 3000);
      const label = document.getElementById('fileLabel');
      label.classList.add('has-file');
      document.getElementById('fileLabelText').textContent = '✅ ' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
      const preview = document.getElementById('filePreview');
      preview.style.display = 'block';
      preview.textContent = attachedFileContent.split('\\n').slice(0, 3).join(' | ');
    };
    reader.readAsText(file);
  }

  function createIncident() {
    const title = document.getElementById('incTitle').value.trim();
    const severity = document.getElementById('incSeverity').value;
    const description = document.getElementById('incDesc').value.trim();
    if (!title || !description) return alert('Title and description required.');
    closeModal();

    const id = 'inc-' + Date.now();
    incidents[id] = { id, title, severity, status: 'open' };
    renderSidebar();
    selectIncident(id);

    // Build enriched description with attached file context
    let enrichedDescription = description;
    if (attachedFileContent) {
      enrichedDescription += '\\n\\n--- ATTACHED CONTEXT (' + attachedFileName + ') ---\\n' + attachedFileContent;
    }

    // Send init when WS is ready
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'init', agentName: id, title, severity, description: enrichedDescription }));
    };

    // Reset form
    document.getElementById('incTitle').value = '';
    document.getElementById('incDesc').value = '';
    document.getElementById('incFile').value = '';
    document.getElementById('fileLabel').classList.remove('has-file');
    document.getElementById('fileLabelText').textContent = '📎 Attach logs, metrics, or error output (.log .txt .json)';
    document.getElementById('filePreview').style.display = 'none';
    attachedFileContent = null;
    attachedFileName = null;
  }

  function selectIncident(id) {
    if (currentIncidentId === id && ws && ws.readyState === WebSocket.OPEN) return;
    currentIncidentId = id;
    document.querySelectorAll('.incident-item').forEach(el => el.classList.remove('active'));
    const item = document.getElementById('inc-' + id);
    if (item) item.classList.add('active');

    // Close existing WS
    if (ws) { ws.onclose = null; ws.close(); ws = null; }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host + '/api/incident/' + id + '/ws');

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      handleWsMessage(msg);
    };
    ws.onclose = () => { if (currentIncidentId === id) updateBar(); };

    document.getElementById('inputWrap').style.display = 'flex';
    clearChat();
  }

  function handleWsMessage(msg) {
    if (msg.type === 'state') {
      const inc = msg.incident;
      if (!inc) return;
      // Remove the temporary local entry (keyed by agentName) if the server
      // assigned a different UUID as the canonical id
      if (inc.agentName && inc.agentName !== inc.id) {
        delete incidents[inc.agentName];
      }
      incidents[inc.id] = inc;
      currentIncidentId = inc.id;
      updateBar(inc);
      renderSidebar();
      clearChat();
      if (msg.history) {
        msg.history.forEach(m => appendMessage(m.role, m.content));
      }
    } else if (msg.type === 'message') {
      appendMessage(msg.message.role, msg.message.content);
    } else if (msg.type === 'token') {
      handleToken(msg.token);
    } else if (msg.type === 'typing') {
      if (msg.value) startTypingIndicator();
    } else if (msg.type === 'message-complete') {
      finalizeStream(msg.content);
    } else if (msg.type === 'workflow-complete') {
      const inc = msg.incident;
      incidents[inc.id] = inc;
      updateBar(inc);
      renderSidebar();
      appendMessage('assistant', msg.message.content);
    } else if (msg.type === 'error') {
      appendMessage('assistant', '⚠️ ' + msg.message);
    }
  }

  let typingEl = null;
  function startTypingIndicator() {
    if (typingEl) return;
    streamBuffer = '';
    typingEl = document.createElement('div');
    typingEl.className = 'msg assistant';
    typingEl.id = 'typing-msg';
    typingEl.innerHTML = '<div class="msg-avatar">🤖</div><div class="msg-body" id="stream-body"><span class="typing-dot">▋</span></div>';
    document.getElementById('chat').appendChild(typingEl);
    scrollChat();
  }

  function handleToken(token) {
    streamBuffer += token;
    const body = document.getElementById('stream-body');
    if (body) {
      body.textContent = streamBuffer;
      const cursor = document.createElement('span');
      cursor.className = 'typing-dot';
      cursor.textContent = '▋';
      body.appendChild(cursor);
    }
    scrollChat();
  }

  function finalizeStream(fullContent) {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
    streamBuffer = '';
    if (fullContent) appendMessage('assistant', fullContent);
  }

  var S = String.fromCharCode(92, 42);
  var RE_BOLD = new RegExp(S+S+'(.+?)'+S+S, 'g');
  var RE_ITALIC = new RegExp(S+'(.+?)'+S, 'g');
  var RE_H3 = new RegExp('^### (.+)$', 'gm');
  var RE_H2 = new RegExp('^## (.+)$', 'gm');
  var RE_H1 = new RegExp('^# (.+)$', 'gm');
  var RE_LI = new RegExp('^- (.+)$', 'gm');
  var RE_UNDER = new RegExp('^_(.+)_$', 'gm');

  function renderMarkdown(text) {
    var s = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    s = s.replace(RE_BOLD, '<strong>$1</strong>');
    s = s.replace(RE_ITALIC, '<em>$1</em>');
    s = s.replace(RE_H3, '<h4>$1</h4>');
    s = s.replace(RE_H2, '<h3>$1</h3>');
    s = s.replace(RE_H1, '<h2>$1</h2>');
    s = s.replace(RE_LI, '<li>$1</li>');
    s = s.replace(RE_UNDER, '<em>$1</em>');
    return s;
  }

  function appendMessage(role, content) {
    const chat = document.getElementById('chat');
    // Remove empty state
    const empty = chat.querySelector('.empty-state');
    if (empty) empty.remove();

    const div = document.createElement('div');
    div.className = 'msg ' + role;
    const avatar = role === 'assistant' ? '🤖' : '👤';
    div.innerHTML = '<div class="msg-avatar">' + avatar + '</div><div class="msg-body"></div>';
    const body = div.querySelector('.msg-body');
    if (role === 'assistant') {
      body.innerHTML = renderMarkdown(content);
    } else {
      body.textContent = content;
    }
    chat.appendChild(div);
    scrollChat();
  }

  function clearChat() {
    document.getElementById('chat').innerHTML = '';
  }

  function scrollChat() {
    const c = document.getElementById('chat');
    c.scrollTop = c.scrollHeight;
  }

  function sendMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'chat', content: text }));
    input.value = '';
  }

  function resolveIncident() {
    const resolution = prompt('Describe the resolution:');
    if (!resolution || !ws) return;
    ws.send(JSON.stringify({ type: 'resolve', resolution }));
  }

  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  function updateBar(inc) {
    const bar = document.getElementById('incidentBar');
    if (!inc) { bar.innerHTML = '<span style="color:var(--muted);font-size:13px;">No incident selected</span>'; return; }
    const sevClass = 'sev-' + inc.severity.toLowerCase();
    const statusClass = 'status-' + inc.status;
    const spinner = inc.workflowRunning
      ? '<div class="workflow-indicator"><div class="spinner"></div> Workflow running…</div>'
      : '';
    bar.innerHTML = '<span class="sev-badge ' + sevClass + '">' + inc.severity + '</span>'
      + '<span class="inc-name">' + esc(inc.title) + '</span>'
      + '<span class="status-badge ' + statusClass + '">' + inc.status + '</span>'
      + spinner;
  }

  function renderSidebar() {
    const list = document.getElementById('incidentList');
    list.innerHTML = '';
    const all = Object.values(incidents).reverse();
    if (all.length === 0) {
      list.innerHTML = '<p style="padding:12px;color:var(--muted);font-size:12px;">No incidents yet</p>';
      return;
    }
    for (const inc of all) {
      const div = document.createElement('div');
      div.className = 'incident-item' + (inc.id === currentIncidentId ? ' active' : '');
      div.id = 'inc-' + inc.id;
      const sevClass = 'sev-' + (inc.severity || 'p2').toLowerCase();
      div.innerHTML = '<div class="inc-title">' + esc(inc.title) + '</div>'
        + '<div class="inc-meta"><span class="sev-badge ' + sevClass + '">' + (inc.severity || '') + '</span>'
        + '<span>' + (inc.status || '') + '</span></div>';
      div.onclick = () => selectIncident(inc.id);
      list.appendChild(div);
    }
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  renderSidebar();

  document.querySelector('.new-incident-btn').addEventListener('click', function() {
    try { openModal(); } catch(e) { console.error('openModal failed:', e); }
  });
</script>
</body>
</html>`;
}
