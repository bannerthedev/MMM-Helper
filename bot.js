require('dotenv').config();
const crypto = require('crypto');
const { Readable } = require('stream');
const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, SlashCommandBuilder, MessageFlags } = require('discord.js');
const { parseMatchText } = require('./matchParser');

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, GUILD_ID, BOT_API_KEY, PORT = 3000 } = process.env;
// ROLES = "Head Caster:123,Caster:456" (highest first). Anyone with none of them is a "Member".
const ROLES = (process.env.ROLES || '').split(',').filter(Boolean).map(r => r.split(':').map(x => x.trim()));
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent] });

const codes = new Map(); // userId -> { code, expires, user }
const tries = new Map(); // userId -> failed attempts
const newCode = () => crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 characters
const rolesOf = (member) => ROLES.filter(([name, id]) =>
  member.roles.cache.has(id) || member.roles.cache.some(r => r.name.trim().toLowerCase() === name.toLowerCase())).map(([name]) => name); // every role they hold, in ROLES order
const roleOf = (member) => rolesOf(member)[0] || 'Member';
const hasRole = (member, names) => rolesOf(member).some(r => names.includes(r.toLowerCase()));
const CASTER = ['caster', 'head caster'], COMMENTATOR = ['commentator', 'head commentator'];

const needKey = (req, res, next) => {
  const a = Buffer.from(String(req.headers['x-api-key'] || '')), b = Buffer.from(String(BOT_API_KEY || ''));
  if (b.length && a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Bad bot API key.' });
};

const app = express();
app.use(express.json());

// ---------- sign-in: the app sends the Discord OAuth code, the bot DMs a sign-in code ----------
app.post('/auth/discord', async (req, res) => {
  try {
    const { code, redirectUri } = req.body;
    const t = await fetch('https://discord.com/api/oauth2/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: redirectUri }) }).then(r => r.json());
    if (!t.access_token) return res.status(400).json({ error: 'Discord sign-in failed. Try again.' });
    const me = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${t.access_token}` } }).then(r => r.json());

    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(me.id).catch(() => null);
    if (!member) return res.status(403).json({ error: 'You need to be in the MMM Discord server to sign in.' });

    console.log(`Sign-in: ${member.displayName} has roles [${rolesOf(member).join(', ')}]`);
    const user = { userId: me.id, username: member.displayName || me.username, role: roleOf(member), roles: rolesOf(member),
      avatar: member.displayAvatarURL({ extension: 'png', size: 128 }) };
    const c = newCode();
    codes.set(me.id, { code: c, expires: Date.now() + 5 * 60 * 1000, user });
    tries.delete(me.id);
    await member.send(`# MMM Official  App — Sign-in Code\n## ||${c}||\nThis code expires in **5 minutes** and only works once. If you didn't try to sign in, you can ignore this.`)
      .catch(() => { throw new Error('dm'); });
    res.json({ userId: me.id, username: user.username });
  } catch (e) {
    console.error(e);
    res.status(e.message === 'dm' ? 403 : 500).json({ error: e.message === 'dm'
      ? "Couldn't DM you. Turn on DMs from server members and try again." : 'Sign-in failed. Try again.' });
  }
});

app.post('/auth/verify', (req, res) => {
  const { userId, code } = req.body;
  const entry = codes.get(userId);
  const n = (tries.get(userId) || 0) + 1; tries.set(userId, n);
  if (n > 5) { codes.delete(userId); return res.status(429).json({ error: 'Too many attempts. Sign in again.' }); }
  if (!entry || Date.now() > entry.expires) return res.status(400).json({ error: 'That code expired. Sign in again.' });
  if (String(code).toUpperCase() !== entry.code) return res.status(400).json({ error: 'Wrong code.' });
  codes.delete(userId); // single use
  res.json({ user: entry.user });
});

// ---------- voice channel (commentators overlay) ----------
// The bot joins the caster's voice channel so it can see WHO IS TALKING (the blue ring in the overlay).
// If a full voice connection fails (Discord now requires DAVE encryption), it falls back to just appearing in the
// channel: the member list still works, but there are no talking rings.
let vcOwner = null, vcChannel = null, vcConn = null;
const speaking = new Set();
const sendVoiceState = (guild, channelId) =>
  guild.shard.send({ op: 4, d: { guild_id: guild.id, channel_id: channelId, self_mute: true, self_deaf: false } });

async function connectVoice(guild, ch) {
  let conn = null;
  try {
    conn = joinVoiceChannel({ channelId: ch.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: true });
    await entersState(conn, VoiceConnectionStatus.Ready, 12000);
    conn.receiver.speaking.on('start', (id) => speaking.add(id));
    conn.receiver.speaking.on('end', (id) => speaking.delete(id));
    vcConn = conn;
    return 'full';
  } catch (e) {
    console.error('Full voice connection failed, using channel-only mode:', e.message);
    try { conn?.destroy(); } catch {}
    sendVoiceState(guild, ch.id);
    return 'basic';
  }
}

app.post('/vc/join', needKey, async (req, res) => {
  try {
    const uid = String(req.body.userId);
    if (vcChannel && vcOwner !== uid) return res.status(409).json({ error: 'The bot is already in use in another voice channel.' });
    const guild = await client.guilds.fetch(GUILD_ID);
    const ch = guild.voiceStates.cache.get(uid)?.channel;
    if (!ch) return res.status(400).json({ error: 'Join a voice channel in Discord first.' });
    if (vcConn) { try { vcConn.destroy(); } catch {} vcConn = null; }
    speaking.clear();
    const mode = await connectVoice(guild, ch);
    vcOwner = uid; vcChannel = ch.id;
    res.json({ channel: ch.name, mode });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not join the voice channel.' }); }
});

app.post('/vc/leave', needKey, async (req, res) => {
  try {
    if (vcChannel && String(req.body.userId) === vcOwner) {
      if (vcConn) { try { vcConn.destroy(); } catch {} vcConn = null; }
      else sendVoiceState(await client.guilds.fetch(GUILD_ID), null);
      speaking.clear(); vcOwner = null; vcChannel = null;
    }
  } catch (e) { console.error(e); }
  res.json({ ok: true });
});

app.get('/vc/members', needKey, async (req, res) => {
  if (!vcChannel) return res.status(404).json({ error: 'Not connected.' });
  const guild = await client.guilds.fetch(GUILD_ID);
  const ch = guild.channels.cache.get(vcChannel);
  if (!ch) return res.status(404).json({ error: 'Not connected.' });
  res.json({ channel: ch.name, members: [...ch.members.values()].filter(m => !m.user.bot)
    .map(m => ({ id: m.id, name: m.displayName, avatar: m.displayAvatarURL({ extension: 'png', size: 128 }), speaking: speaking.has(m.id) })) });
});

// ---------- YouTube: the bot holds ONE Google login so casters never sign in to Google ----------
let ytCache = { token: null, exp: 0 };
async function ytToken() {
  if (ytCache.token && Date.now() < ytCache.exp - 60000) return ytCache.token;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) throw new Error('Google login failed: ' + (j.error_description || j.error));
  ytCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return ytCache.token;
}
async function yt(method, endpoint, query, body) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams(query)}`, { method,
    headers: { Authorization: `Bearer ${await ytToken()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'YouTube request failed');
  return j;
}
const FIXED_DESCRIPTION = 'If you want to join the discord:\nhttps://discord.gg/mmml';
const tidy = (v, d) => String(v || d).replace(/[<>\n\r]/g, '').trim().slice(0, 30) || d;

app.post('/yt/start', needKey, async (req, res) => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(String(req.body.userId)).catch(() => null);
    if (!member || !hasRole(member, CASTER)) return res.status(403).json({ error: 'Only casters can start a stream.' });
    const title = `${tidy(req.body.team1, 'Team 1')} vs ${tidy(req.body.team2, 'Team 2')} | Monke Monke Monke | ${tidy(req.body.round, 'Bracket Round 1')}`;

    let stream = (await yt('GET', 'liveStreams', { part: 'snippet,cdn', mine: 'true', maxResults: '10' })).items?.[0];
    if (!stream) stream = await yt('POST', 'liveStreams', { part: 'snippet,cdn' }, { snippet: { title: 'MMM Stream' },
      cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' } });
    const b = await yt('POST', 'liveBroadcasts', { part: 'snippet,status,contentDetails' }, {
      snippet: { title, description: FIXED_DESCRIPTION, scheduledStartTime: new Date(Date.now() + 60000).toISOString() },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: true } });
    await yt('POST', 'liveBroadcasts/bind', { id: b.id, part: 'id,contentDetails', streamId: stream.id });
    const tr = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${b.id}&uploadType=media`, { method: 'POST',
      headers: { Authorization: `Bearer ${await ytToken()}`, 'Content-Type': 'image/png' }, body: fs.readFileSync(path.join(__dirname, 'thumbnail.png')) });

    // If the bot is connected to a voice channel, post the live link in that voice channel's text chat
    if (vcChannel) {
      const ch = guild.channels.cache.get(vcChannel);
      if (ch?.send) await ch.send(`🔴 **LIVE:** ${title}\nhttps://www.youtube.com/watch?v=${b.id}`).catch(console.error);
    }
    res.json({ title, streamKey: stream.cdn.ingestionInfo.streamName, thumbOk: tr.ok });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ---------- app updates: the app asks the bot, the bot reads your latest GitHub release ----------
// Set GITHUB_REPO (owner/name) and, if the repo is private, GITHUB_TOKEN. The exe is never public.
let relCache = { at: 0, data: null };
async function latestRelease() {
  if (relCache.data && Date.now() - relCache.at < 60000) return relCache.data;
  if (!process.env.GITHUB_REPO) throw new Error('GITHUB_REPO is not set on the bot.');
  const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/releases/latest`, { headers: ghHeaders('application/vnd.github+json') });
  if (!r.ok) throw new Error(`Could not read the latest release (${r.status}).`);
  const j = await r.json();
  const asset = (j.assets || []).find(a => /\.exe$/i.test(a.name));
  if (!asset) throw new Error('The latest release has no .exe file attached.');
  relCache = { at: Date.now(), data: { version: String(j.tag_name).replace(/^v/i, ''), notes: j.body || '', asset } };
  return relCache.data;
}
const ghHeaders = (accept) => ({ Accept: accept, 'User-Agent': 'mmm-bot', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) });
app.get('/update/latest', needKey, async (req, res) => {
  try { const r = await latestRelease(); res.json({ version: r.version, notes: r.notes }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/update/download', needKey, async (req, res) => {
  try {
    const { asset } = await latestRelease();
    const r = await fetch(asset.url, { headers: ghHeaders('application/octet-stream'), redirect: 'follow' });
    if (!r.ok) return res.status(500).json({ error: `Could not download the update (${r.status}).` });
    res.setHeader('Content-Type', 'application/octet-stream');
    if (asset.size) res.setHeader('Content-Length', asset.size);
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ---------- match channel + /line-up (feeds the app's Commentator Tools) ----------
const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
const LINEUP_FILE = path.join(__dirname, 'lineups.json');
const lineups = new Map(); // normalised team name -> { team, players: [] }
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(LINEUP_FILE, 'utf8')))) lineups.set(k, v); } catch {}
const saveLineups = () => { try { fs.writeFileSync(LINEUP_FILE, JSON.stringify(Object.fromEntries(lineups))); } catch {} };

// The app asks for the commentators, team names, ref and caster found in MATCH_CHANNEL_ID, plus all saved line-ups.
app.post('/match/info', needKey, async (req, res) => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(String(req.body.userId)).catch(() => null);
    if (!member || !hasRole(member, COMMENTATOR)) return res.status(403).json({ error: 'Only commentators can use Commentator Tools.' });
    if (!process.env.MATCH_CHANNEL_ID) return res.status(400).json({ error: 'MATCH_CHANNEL_ID is not set on the bot.' });
    const ch = await client.channels.fetch(process.env.MATCH_CHANNEL_ID).catch(() => null);
    if (!ch?.messages) return res.status(500).json({ error: 'The match channel was not found. Check MATCH_CHANNEL_ID and that the bot can see that channel.' });
    const out = { comm: [], team1: null, team2: null, ref: null, caster: null };
    const msgs = await ch.messages.fetch({ limit: 25 }); // newest first
    let used = null;
    for (const m of msgs.values()) { // the LATEST message that contains match details wins
      const embeds = m.embeds.map(e => [e.title, e.description, ...(e.fields || []).map(f => `${f.name}: ${f.value}`)].filter(Boolean).join('\n')).join('\n');
      const o = { comm: [], team1: null, team2: null, ref: null, caster: null };
      parseMatchText(`${m.cleanContent}\n${embeds}`, o);
      if (o.team1 || o.team2 || o.comm.length || o.ref || o.caster) { Object.assign(out, o); used = m; break; }
    }
    const sample = used ? null : String(msgs.first()?.cleanContent || '(no text - is Message Content Intent on?)').slice(0, 140);
    res.json({ commentators: [out.comm[0] || null, out.comm[1] || null], team1: out.team1, team2: out.team2, ref: out.ref, caster: out.caster,
      channel: ch.name, found: !!used, sample, lineups: Object.fromEntries([...lineups].map(([k, v]) => [k, v.players])) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not read the match channel.' }); }
});

const lineUpCommand = new SlashCommandBuilder().setName('line-up').setDescription('Set or view the players for a team')
  .addStringOption(o => o.setName('team').setDescription('Team name').setRequired(true))
  .addStringOption(o => o.setName('players').setDescription('Players separated by commas (type "clear" to remove). Leave empty to view.'));

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'line-up') return;
  const team = i.options.getString('team', true).trim().slice(0, 40), raw = i.options.getString('players'), key = norm(team);
  if (raw === null) {
    const l = lineups.get(key);
    return i.reply(l ? { content: `**${l.team}** line-up: ${l.players.join(', ')}` } : { content: `No line-up saved for **${team}** yet.`, flags: MessageFlags.Ephemeral });
  }
  if (!i.member || !hasRole(i.member, [...CASTER, ...COMMENTATOR])) return i.reply({ content: 'Only casters and commentators can set a line-up.', flags: MessageFlags.Ephemeral });
  if (raw.trim().toLowerCase() === 'clear') { lineups.delete(key); saveLineups(); return i.reply(`Cleared the line-up for **${team}**.`); }
  const players = raw.split(/[,\n]/).map(p => p.trim().slice(0, 30)).filter(Boolean).slice(0, 10);
  if (!players.length) return i.reply({ content: 'List the players separated by commas.', flags: MessageFlags.Ephemeral });
  lineups.set(key, { team, players }); saveLineups();
  i.reply(`Saved the line-up for **${team}**: ${players.join(', ')}`);
});

client.once('ready', async () => {
  console.log(`Bot online as ${client.user.tag}`);
  try { await (await client.guilds.fetch(GUILD_ID)).commands.set([lineUpCommand.toJSON()]); console.log('Slash command /line-up registered'); }
  catch (e) { console.error('Could not register /line-up:', e.message); }
  app.listen(PORT, () => console.log(`API on :${PORT}`));
});
client.login(DISCORD_TOKEN);
