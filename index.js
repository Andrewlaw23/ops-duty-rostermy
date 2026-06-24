export class RosterRoom {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      const currentRoster = await this.state.storage.get("roster") || this.getDefaultRoster();
      server.send(JSON.stringify({ type: "init", data: currentRoster }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws, message) {
    try {
      const msg = JSON.parse(message);
      if (msg.type === "update") {
        await this.state.storage.put("roster", msg.data);
        for (const client of this.state.getWebSockets()) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "update", data: msg.data }));
          }
        }
      }
    } catch (e) {
      console.error("WebSocket error:", e);
    }
  }

  getDefaultRoster() {
    return {
      weeks: [
        { week: "Week 1", monday: "", tuesday: "", wednesday: "", thursday: "", friday: "", saturday: "", sunday: "" },
        { week: "Week 2", monday: "", tuesday: "", wednesday: "", thursday: "", friday: "", saturday: "", sunday: "" },
        { week: "Week 3", monday: "", tuesday: "", wednesday: "", thursday: "", friday: "", saturday: "", sunday: "" },
        { week: "Week 4", monday: "", tuesday: "", wednesday: "", thursday: "", friday: "", saturday: "", sunday: "" }
      ],
      notes: "",
      lastUpdated: new Date().toISOString()
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML, { headers: { "Content-Type": "text/html" } });
    }
    const id = env.ROSTER.idFromName("main");
    const room = env.ROSTER.get(id);
    return room.fetch(request);
  }
};

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Live Duty Roster</title>
<style>
* { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
body { max-width: 1200px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
h1 { text-align: center; color: #333; }
.status { text-align: center; padding: 8px; border-radius: 6px; margin-bottom: 16px; font-size: 14px; }
.status.connected { background: #d4edda; color: #155724; }
.status.disconnected { background: #f8d7da; color: #721c24; }
.status.syncing { background: #fff3cd; color: #856404; }
table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border-radius: 8px; overflow: hidden; margin-bottom: 24px; }
th, td { padding: 12px; text-align: center; border: 1px solid #e0e0e0; }
th { background: #1a73e8; color: white; font-weight: 600; }
td { background: #fafafa; }
td input { width: 100%; padding: 8px; border: 2px solid transparent; border-radius: 4px; text-align: center; font-size: 14px; background: transparent; }
td input:focus { outline: none; border-color: #1a73e8; background: white; }
td input:hover { background: #f0f0f0; }
.week-label { font-weight: bold; background: #e8f0fe; color: #1a73e8; }
.notes-section { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
.notes-section h2 { margin-top: 0; color: #333; font-size: 18px; }
.notes-section textarea { width: 100%; min-height: 120px; padding: 12px; border: 2px solid #e0e0e0; border-radius: 6px; font-size: 14px; resize: vertical; font-family: inherit; }
.notes-section textarea:focus { outline: none; border-color: #1a73e8; }
.last-updated { text-align: center; color: #666; font-size: 12px; margin-top: 12px; }
</style>
</head>
<body>
<h1>Live Duty Roster</h1>
<div id="status" class="status disconnected">Connecting...</div>
<table>
<thead><tr><th>Week</th><th>Monday</th><th>Tuesday</th><th>Wednesday</th><th>Thursday</th><th>Friday</th><th>Saturday</th><th>Sunday</th></tr></thead>
<tbody id="roster-body"></tbody>
</table>
<div class="notes-section">
<h2>Notes</h2>
<textarea id="notes" placeholder="Add notes here... All users will see this live."></textarea>
</div>
<div class="last-updated" id="last-updated"></div>
<script>
const statusEl = document.getElementById('status');
const tbody = document.getElementById('roster-body');
const notesEl = document.getElementById('notes');
const lastUpdatedEl = document.getElementById('last-updated');
let rosterData = null, ws = null, reconnectTimer = null, syncTimer = null, isRemoteUpdate = false;
const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

function renderRoster() {
  if (!rosterData || !rosterData.weeks) return;
  tbody.innerHTML = '';
  rosterData.weeks.forEach((week, wi) => {
    const tr = document.createElement('tr');
    let html = '<td class="week-label">' + week.week + '</td>';
    days.forEach(day => {
      html += '<td><input value="' + (week[day]||'') + '" placeholder="Name" data-week="' + wi + '" data-day="' + day + '" oninput="onCellChange(event)"></td>';
    });
    tr.innerHTML = html;
    tbody.appendChild(tr);
  });
  isRemoteUpdate = true;
  notesEl.value = rosterData.notes || '';
  isRemoteUpdate = false;
  lastUpdatedEl.textContent = rosterData.lastUpdated ? 'Last updated: ' + new Date(rosterData.lastUpdated).toLocaleString() : '';
}

function onCellChange(e) {
  const el = e.target;
  rosterData.weeks[parseInt(el.dataset.week)][el.dataset.day] = el.value;
  rosterData.lastUpdated = new Date().toISOString();
  queueSync();
}

function onNotesChange(e) {
  if (isRemoteUpdate) return;
  rosterData.notes = e.target.value;
  rosterData.lastUpdated = new Date().toISOString();
  queueSync();
}

function queueSync() {
  statusEl.textContent = 'Syncing...';
  statusEl.className = 'status syncing';
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'update',data:rosterData}));
  }, 300);
}

notesEl.addEventListener('input', onNotesChange);

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(protocol + '//' + location.host + '/websocket');
  ws.onopen = () => { statusEl.textContent = 'Connected - changes sync live'; statusEl.className = 'status connected'; clearTimeout(reconnectTimer); };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'init' || msg.type === 'update') {
      const active = document.activeElement, selStart = active?.selectionStart, selEnd = active?.selectionEnd;
      const activeTag = active?.tagName, activeWeek = active?.dataset?.week, activeDay = active?.dataset?.day;
      rosterData = msg.data;
      renderRoster();
      if (activeTag === 'INPUT' && activeWeek !== undefined) {
        const newInput = document.querySelector('input[data-week="' + activeWeek + '"][data-day="' + activeDay + '"]');
        if (newInput) { newInput.focus(); newInput.setSelectionRange(selStart, selEnd); }
      } else if (activeTag === 'TEXTAREA' && active.id === 'notes') {
        notesEl.focus(); notesEl.setSelectionRange(selStart, selEnd);
      }
      statusEl.textContent = 'Connected - all changes saved'; statusEl.className = 'status connected';
    }
  };
  ws.onclose = () => { statusEl.textContent = 'Disconnected - reconnecting...'; statusEl.className = 'status disconnected'; reconnectTimer = setTimeout(connect, 3000); };
  ws.onerror = () => { statusEl.textContent = 'Connection error'; statusEl.className = 'status disconnected'; };
}
connect();
</script>
</body>
</html>`;
