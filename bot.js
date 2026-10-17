require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, GUILD_ID, PORT = 3000 } = process.env;
const ROLES = (process.env.ROLES || '').split(',').filter(Boolean).map(r => r.split(':'));
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates] });
const codes = new Map(); // userId -> { code, expires, user }
const tries = new Map(); // userId -> failed attempts

const newCode = () => crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 chars

function roleOf(member) {
  for (const [name, id] of ROLES) if (member.roles.cache.has(id)) return name;
  return 'Member';
}

const app = express();
app.use(express.json());

// Step 1: app sends Discord OAuth code -> bot identifies user, detects role, DMs sign-in code
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

    const user = { userId: me.id, username: member.displayName || me.username, role: roleOf(member) };
    const c = newCode();
    codes.set(me.id, { code: c, expires: Date.now() + 5 * 60 * 1000, user });
    tries.delete(me.id);
    await member.send(`# MMM Official  App — Sign-in Code\n## ||${c}||\nThis code expires in **5 minutes** and only works once. If you didn't try to sign in, you can ignore this.`)
      .catch(() => { throw new Error('dm'); });
    res.json({ userId: me.id, username: user.username });
  } catch (e) {
    res.status(e.message === 'dm' ? 403 : 500).json({ error: e.message === 'dm'
      ? "Couldn't DM you. Turn on DMs from server members and try again." : 'Sign-in failed. Try again.' });
  }
});

// Step 2: app submits the code
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

// ---- Voice channel (timer app commentators overlay) ----
const needKey = (req, res, next) => (process.env.BOT_API_KEY && req.headers['x-api-key'] === process.env.BOT_API_KEY) ? next() : res.status(401).json({ error: 'Bad bot API key.' });
let vcOwner = null;
app.post('/vc/join', needKey, async (req, res) => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const existing = getVoiceConnection(guild.id);
    if (existing && vcOwner !== req.body.userId) return res.status(409).json({ error: 'The bot is already in use in another voice channel.' });
    const member = await guild.members.fetch(req.body.userId).catch(() => null);
    const ch = member?.voice?.channel;
    if (!ch) return res.status(400).json({ error: 'Join a voice channel in Discord first.' });
    joinVoiceChannel({ channelId: ch.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
    vcOwner = req.body.userId;
    res.json({ channel: ch.name });
  } catch (e) { res.status(500).json({ error: 'Could not join the voice channel.' }); }
});
app.post('/vc/leave', needKey, (req, res) => {
  const c = getVoiceConnection(GUILD_ID);
  if (c && vcOwner === req.body.userId) { c.destroy(); vcOwner = null; }
  res.json({ ok: true });
});
app.get('/vc/members', needKey, async (req, res) => {
  const c = getVoiceConnection(GUILD_ID);
  if (!c) return res.status(404).json({ error: 'Not connected.' });
  const ch = await client.channels.fetch(c.joinConfig.channelId);
  res.json({ members: [...ch.members.values()].filter(m => !m.user.bot)
    .map(m => ({ id: m.id, name: m.displayName, avatar: m.displayAvatarURL({ extension: 'png', size: 128 }) })) });
});

client.once('ready', () => { console.log(`Bot online as ${client.user.tag}`); app.listen(PORT, () => console.log(`API on :${PORT}`)); });
client.login(DISCORD_TOKEN);
