// Commentator audio: the bot listens to each person in the voice channel SEPARATELY, mixes only the people who are switched on,
// and streams that mix (as small Opus packets) to the caster's Match Timer. OBS captures the Match Timer with
// "Application Audio Capture", so anyone switched off stops reaching the stream while they can still talk in Discord.
const OpusScript = require('opusscript');
const { EndBehaviorType } = require('@discordjs/voice');
const { WebSocketServer } = require('ws');

const FRAME = 960; // samples per channel per 20 ms at 48 kHz
let enc = null, ws = null, conn = null, selfId = null, timer = null, next = 0;
let muted = new Set();
const streams = new Map(); // userId -> { q: [pcm buffers], stream }

function subscribe(id) {
  if (!conn || id === selfId || streams.has(id)) return;
  const dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const st = { q: [], stream: null };
  try {
    const s = conn.receiver.subscribe(id, { end: { behavior: EndBehaviorType.Manual } });
    st.stream = s;
    s.on('data', (pkt) => { try { st.q.push(dec.decode(pkt)); if (st.q.length > 30) st.q.splice(0, st.q.length - 8); } catch {} });
    s.on('error', () => {});
  } catch { return; }
  streams.set(id, st);
}

function mix() {
  const open = ws && ws.readyState === 1;
  const out = new Int16Array(FRAME * 2);
  let any = false;
  for (const [id, st] of streams) {
    const f = st.q.shift();              // always consume, so muted people don't pile up
    if (!f || !open || muted.has(id) || f.length < FRAME * 4) continue;
    any = true;
    for (let i = 0; i < FRAME * 2; i++) { const v = out[i] + f.readInt16LE(i * 2); out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
  }
  if (!any || !open) return;
  try { ws.send(enc.encode(Buffer.from(out.buffer, out.byteOffset, out.byteLength), FRAME)); } catch {}
}

function tick() { const now = Date.now(); while (next <= now) { next += 20; mix(); } }

function start(c, botId) {
  stop();
  conn = c; selfId = botId;
  enc = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  c.receiver.speaking.on('start', (id) => subscribe(id));
  next = Date.now();
  timer = setInterval(tick, 10);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  for (const st of streams.values()) { try { st.stream?.destroy(); } catch {} }
  streams.clear();
  conn = null;
}

const setMuted = (list) => { muted = new Set((Array.isArray(list) ? list : []).map(String)); };

function attach(server, verify) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/vc/audio') { socket.destroy(); return; }
    if (!verify(req, u)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (sock) => {
      if (ws) { try { ws.close(); } catch {} }
      ws = sock;
      sock.on('close', () => { if (ws === sock) ws = null; });
    });
  });
}

module.exports = { start, stop, setMuted, attach };
