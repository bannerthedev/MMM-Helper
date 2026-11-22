require('dotenv').config();
const crypto = require('crypto');
const { Readable } = require('stream');
const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, SlashCommandBuilder, MessageFlags } = require('discord.js');
const { parseMatchText, extractTimes } = require('./matchParser');

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, GUILD_ID, BOT_API_KEY, PORT = 3000 } = process.env;
// ROLES = "Head Caster:123,Caster:456" (highest first). Anyone with none of them is a "Member".
const ROLES = (process.env.ROLES || '').split(',').filter(Boolean).map(r => r.split(':').map(x => x.trim()));
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent] });

const codes = new Map(); // userId -> { code, expires, user }
const tries = new Map(); // userId -> failed attempts
const newCode = () => crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 characters
const SESSION_SECRET = process.env.PLAYER_SESSION_SECRET || '';
function signSession(user){if(!SESSION_SECRET)throw new Error('PLAYER_SESSION_SECRET is not configured.');const payload=Buffer.from(JSON.stringify({user,exp:Date.now()+7*24*60*60*1000})).toString('base64url');const sig=crypto.createHmac('sha256',SESSION_SECRET).update(payload).digest('base64url');return payload+'.'+sig;}
function readSession(token){try{const [payload,sig]=String(token||'').split('.');const expected=crypto.createHmac('sha256',SESSION_SECRET).update(payload).digest();const actual=Buffer.from(sig,'base64url');if(!SESSION_SECRET||actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return null;const data=JSON.parse(Buffer.from(payload,'base64url').toString());return data.exp>Date.now()?data.user:null;}catch{return null;}}
function requireSession(req,res,next){const user=readSession((req.headers.authorization||'').replace(/^Bearer\s+/i,''));if(!user)return res.status(401).json({error:'Please sign in with Discord again.'});req.sessionUser=user;next();}

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
app.use((req,res,next)=>{const allowed=(process.env.WEBSITE_ORIGIN||'').split(',').map(x=>x.trim()).filter(Boolean);const origin=req.headers.origin;if(origin&&(!allowed.length||allowed.includes(origin))){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, x-api-key');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');}if(req.method==='OPTIONS')return res.sendStatus(204);next();});
app.use(express.json({limit:'28mb'}));
app.get('/health', (req, res) => res.json({ ok: true }));

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
    const user = { userId: me.id, username: me.username, displayName: member.displayName || me.global_name || me.username, role: roleOf(member), roles: rolesOf(member), avatar: member.displayAvatarURL({ extension: 'png', size: 128 }), discordAvatar: me.avatar || null };
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
  res.json({ user: entry.user, token: signSession(entry.user) });
});

// ---------- MMM applications + player portal data ----------
const APP_DIR=process.env.APP_DATA_DIR||__dirname;fs.mkdirSync(APP_DIR,{recursive:true});
const APP_FILE=path.join(APP_DIR,'applications.json'), APP_CONFIG_FILE=path.join(APP_DIR,'application-questions.json'), PLAYER_FILE=path.join(APP_DIR,'player-stats.json');
const readJson=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return d;}};
const writeJson=(f,v)=>{const tmp=f+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v,null,2));fs.renameSync(tmp,f);};
let applications=readJson(APP_FILE,[]), playerStats=readJson(PLAYER_FILE,{});
const DEFAULT_APP_QUESTIONS={
 caster:[{id:'email',label:'What is your email?',type:'email',required:true,private:true},{id:'discord',label:'What is your discord username?',type:'text',required:true},{id:'why',label:'Why would you like to become a caster for MMM?',type:'textarea',required:true},{id:'obs',label:'How familiar are you with OBS?',type:'range',required:true},{id:'obsVideo',label:'OBS demonstration video',type:'filelink',required:true},{id:'speed',label:'What is your Upload & Download Speed?',type:'text',required:true},{id:'pc',label:'Please list your PC specifications (CPU, GPU, RAM, etc).',type:'textarea',required:true},{id:'matches',label:'Do you understand the 3–5 matches per season requirement?',type:'agree',required:true},{id:'guidance',label:'Do you agree to follow head caster guidance?',type:'agree',required:true},{id:'questions',label:'If you have any questions please place them here.',type:'textarea',required:false}],
 ref:[{id:'email',label:'What is your email?',type:'email',required:true,private:true},{id:'discord',label:'What is your discord username?',type:'text',required:true},{id:'rules',label:'Did you read the rulebook?',type:'select',required:true},{id:'start',label:'What time must the match start if scheduled for 6?',type:'select',required:true},{id:'2v4',label:'Can you 2v4 in MMM?',type:'select',required:true},{id:'active',label:'Will you be active?',type:'select',required:true},{id:'biased',label:'If a player says you are biased and refuses to start the round, what do you do?',type:'textarea',required:true},{id:'release',label:'After runners run, how long before taggers are released?',type:'select',required:true},{id:'timecap',label:'What is timecap?',type:'select',required:true}],
 staff:[{id:'email',label:'What is your email?',type:'email',required:true,private:true},{id:'discord',label:'What is your discord username?',type:'text',required:true},{id:'age',label:'What is your age?',type:'number',required:true},{id:'experience',label:'Do you have moderator experience? List league and dates.',type:'textarea',required:true},{id:'why',label:'Why should we accept you?',type:'textarea',required:true},{id:'ai',label:'Do you understand that any use of AI means denial?',type:'select',required:true}],
 commentator:[{id:'email',label:'What is your email?',type:'email',required:true,private:true},{id:'discord',label:'What is your discord username?',type:'text',required:true},{id:'rules',label:'Do you know in-game callouts and league rules?',type:'textarea',required:true},{id:'experience',label:'Commentating experience and Discord servers',type:'textarea',required:true},{id:'why',label:'Why should you be a commentator?',type:'textarea',required:true},{id:'mic',label:'What microphone do you use on PC?',type:'text',required:true}]
};
let appQuestions=readJson(APP_CONFIG_FILE,readJson(path.join(__dirname,'application-questions.json'),DEFAULT_APP_QUESTIONS));if(!fs.existsSync(APP_CONFIG_FILE))writeJson(APP_CONFIG_FILE,appQuestions);
const listEnv=n=>(process.env[n]||'').split(',').map(x=>x.trim()).filter(Boolean);
const reviewerIds=(type)=>new Set([...listEnv('APP_REVIEWER_IDS_ALL'),...listEnv('APP_REVIEWER_IDS_'+type.toUpperCase())]);
const editorIds=()=>new Set(listEnv('APP_EDITOR_IDS'));
async function getAppMember(uid){const guild=await client.guilds.fetch(GUILD_ID);return await guild.members.fetch(uid).catch(()=>null);}
async function canReview(user,type){if(reviewerIds(type).has(user.userId)||editorIds().has(user.userId))return true;const m=await getAppMember(user.userId);if(!m)return false;const roleNames={caster:['head caster','caster'],ref:['head ref','ref manager','referee manager'],staff:['head staff','staff manager'],commentator:['head commentator','commentator']};return rolesOf(m).some(r=>(roleNames[type]||[]).includes(r.toLowerCase()));}
async function canEditApps(user){if(editorIds().has(user.userId))return true;const m=await getAppMember(user.userId);return !!m&&rolesOf(m).some(r=>['owner','admin','head staff'].includes(r.toLowerCase()));}
async function sendAppEmail(to,subject,html){if(!process.env.RESEND_API_KEY)throw new Error('RESEND_API_KEY is not configured.');const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.APP_FROM_EMAIL||'MMM Applications <onboarding@resend.dev>',to,subject,html})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||'Email delivery failed.');return j;}
const appLabel=t=>({caster:'Caster',ref:'Referee',staff:'Staff',commentator:'Commentator'}[t]||t);
const acceptedText={caster:'Someone on the team has accepted your Caster app. Please go to the Discord and download the scenes, then wait for an official match to happen in the assignments channels.',ref:'Someone on the team has accepted your Referee app. Please go to the Discord and wait for an official match to happen in the assignments channels. If you do not have a timer, go to ref-downloads and download the timer.',commentator:'Someone on the team has accepted your Commentator app. Please go to the Discord and wait for an official match to happen in the assignments channels. Please go to Banner for the commentator script and tell him who is commentating and what the teams are.',staff:'Someone on the team has accepted your Staff app. Please go to the Discord and look at staff-announcements and review the Staff Structure or Staff Expectations.'};
app.get('/applications/questions',(req,res)=>res.json({questions:appQuestions}));
app.post('/applications/submit',requireSession,async(req,res)=>{try{const {type,answers,files=[]}=req.body||{};if(!appQuestions[type]||!answers||typeof answers!=='object')return res.status(400).json({error:'Invalid application.'});const qs=appQuestions[type];for(const q of qs){const v=answers[q.id];if(q.required&&!(typeof v==='string'?v.trim():v))return res.status(400).json({error:`Required question missing: ${q.label}`});}const email=String(answers.email||'').trim();if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({error:'Enter a valid email address.'});if(!Array.isArray(files)||files.length>2)return res.status(400).json({error:'Too many attachments.'});const savedFiles=[];const uploadDir=path.join(APP_DIR,'application-uploads');fs.mkdirSync(uploadDir,{recursive:true});for(const f of files){if(!f||typeof f.data!=='string'||f.data.length>28*1024*1024)return res.status(400).json({error:'Invalid or oversized attachment.'});const name=path.basename(String(f.name||'video.bin')).replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100);const id=crypto.randomUUID();const ext=path.extname(name).slice(0,12);const filePath=path.join(uploadDir,id+ext);fs.writeFileSync(filePath,Buffer.from(f.data,'base64'));savedFiles.push({id,name,filePath});}const id=crypto.randomUUID();const record={id,type,status:'pending',createdAt:new Date().toISOString(),applicantId:req.sessionUser.userId,applicantName:req.sessionUser.displayName||req.sessionUser.username,answers,files:savedFiles};applications.unshift(record);writeJson(APP_FILE,applications);const reviewerEmails=[...new Set([...listEnv('APP_ALL_EMAILS'),...listEnv('APP_REVIEWER_EMAILS_'+type.toUpperCase())])];const summary=Object.entries(answers).filter(([k])=>k!=='email').map(([k,v])=>`<p><b>${String(k).replace(/[<>]/g,'')}</b>: ${String(v).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</p>`).join('');if(reviewerEmails.length){const reviewUrl=(process.env.WEBSITE_ORIGIN||'').split(',')[0].replace(/\/$/,'')+'/';await sendAppEmail(reviewerEmails,`New ${appLabel(type)} application`, `<h2>New ${appLabel(type)} application</h2><p>Dear MMM reviewer, someone submitted a ${appLabel(type)} application.</p><p>Applicant: ${record.applicantName}</p>${summary}<p>Sign in to the MMM website and open Applications & Staff to review it. <a href="${reviewUrl}">Open MMM website</a></p>`).catch(e=>console.error('Reviewer email:',e.message));}res.json({ok:true,id});}catch(e){console.error('Application submit:',e);res.status(500).json({error:e.message||'Could not submit application.'});}});
app.get('/applications/review',requireSession,async(req,res)=>{try{const allowed=[];for(const t of ['caster','ref','staff','commentator'])if(await canReview(req.sessionUser,t))allowed.push(t);const rows=applications.filter(a=>allowed.includes(a.type)).map(a=>({id:a.id,type:a.type,status:a.status,createdAt:a.createdAt,applicantName:a.applicantName,answers:Object.fromEntries(Object.entries(a.answers).filter(([k])=>k!=='email')),files:a.files.map(f=>({name:f.name,id:f.id}))}));res.json({applications:rows});}catch(e){res.status(500).json({error:'Could not load applications.'});}});
app.get('/applications/config',requireSession,async(req,res)=>{if(!await canEditApps(req.sessionUser))return res.status(403).json({error:'You are not allowed to edit applications.'});res.json({questions:appQuestions});});
app.put('/applications/config',requireSession,async(req,res)=>{try{if(!await canEditApps(req.sessionUser))return res.status(403).json({error:'You are not allowed to edit applications.'});const {type,questions}=req.body||{};if(!appQuestions[type]||!Array.isArray(questions)||questions.length>40||JSON.stringify(questions).length>30000)return res.status(400).json({error:'Invalid question configuration.'});if(questions.some(q=>!q.id||!q.label||!['text','email','number','textarea','select','range','agree','filelink'].includes(q.type)))return res.status(400).json({error:'Each question needs an id, label, and supported type.'});appQuestions={...appQuestions,[type]:questions};writeJson(APP_CONFIG_FILE,appQuestions);res.json({ok:true});}catch(e){res.status(500).json({error:'Could not save questions.'});}});
app.post('/applications/:id/:decision',requireSession,async(req,res)=>{try{const a=applications.find(x=>x.id===req.params.id),decision=req.params.decision;if(!a||!['accept','deny'].includes(decision))return res.status(404).json({error:'Application not found.'});if(!await canReview(req.sessionUser,a.type))return res.status(403).json({error:'You cannot review this application.'});if(a.status!=='pending')return res.status(409).json({error:'This application has already been reviewed.'});if(decision==='accept'){const roleId=process.env['APP_ROLE_ID_'+a.type.toUpperCase()];if(roleId){const m=await getAppMember(a.applicantId);if(!m)return res.status(409).json({error:'Applicant is no longer in the MMM Discord server.'});await m.roles.add(roleId,`Accepted ${appLabel(a.type)} application`);}await sendAppEmail([a.answers.email],`MMM ${appLabel(a.type)} application accepted`,`<p>Dear ${String(a.applicantName||'applicant').replace(/[<>]/g,'')},</p><p>${acceptedText[a.type]}</p><p>MMM Team</p>`);}a.status=decision==='accept'?'accepted':'denied';a.reviewedAt=new Date().toISOString();a.reviewedBy=req.sessionUser.userId;writeJson(APP_FILE,applications);res.json({ok:true,status:a.status});}catch(e){console.error('Application decision:',e);res.status(500).json({error:e.message||'Could not update application.'});}});
app.get('/applications/file/:id',requireSession,async(req,res)=>{const a=applications.find(x=>x.files.some(f=>f.id===req.params.id));if(!a||!await canReview(req.sessionUser,a.type))return res.status(404).json({error:'File not found.'});const f=a.files.find(x=>x.id===req.params.id);res.download(f.filePath,f.name);});
// Player profile endpoints retained alongside the new application system.
app.get('/public/player-stats',(req,res)=>res.json({players:Object.values(playerStats).map(p=>({...p,discordId:undefined,email:undefined}))}));
app.get('/player/me',requireSession,(req,res)=>res.json({user:req.sessionUser,player:playerStats[req.sessionUser.userId]||null}));
app.get('/admin/player-stats',needKey,(req,res)=>res.json({players:Object.values(playerStats)}));
app.put('/admin/player-stats',needKey,(req,res)=>{const p=req.body?.player;if(!p?.discordId)return res.status(400).json({error:'player.discordId is required.'});playerStats[p.discordId]=p;writeJson(PLAYER_FILE,playerStats);res.json({ok:true});});
app.delete('/admin/player-stats/:discordId',needKey,(req,res)=>{delete playerStats[req.params.discordId];writeJson(PLAYER_FILE,playerStats);res.json({ok:true});});

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
    await entersState(conn, VoiceConnectionStatus.Ready, 8000);
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
// pasted values often carry spaces, quotes, a newline, or a leading NAME= : clean them
const envClean = (name) => String(process.env[name] || '').trim().replace(/^["']+|["']+$/g, '').replace(new RegExp('^' + name + '\\s*='), '').trim();
const refreshTokenClean = () => { const raw = envClean('GOOGLE_REFRESH_TOKEN'); const m = raw.match(/1\/\/[A-Za-z0-9_\-.~]+/); return m ? m[0] : raw; };
let ytCache = { token: null, exp: 0 };
async function ytToken() {
  if (ytCache.token && Date.now() < ytCache.exp - 60000) return ytCache.token;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
    client_id: envClean('GOOGLE_CLIENT_ID'), client_secret: envClean('GOOGLE_CLIENT_SECRET'),
    refresh_token: refreshTokenClean(), grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) console.error(`Google token refresh failed (${j.error}): client id starts ${envClean('GOOGLE_CLIENT_ID').slice(0, 12)}..., token length ${refreshTokenClean().length}`);
  if (!r.ok) { const e = new Error('Google login failed: ' + (j.error_description || j.error)); e.code = j.error; throw e; }
  ytCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return ytCache.token;
}
async function yt(method, endpoint, query, body) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams(query)}`, { method,
    headers: { Authorization: `Bearer ${await ytToken()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error?.message || 'YouTube request failed'); e.reason = j.error?.errors?.[0]?.reason; throw e; }
  return j;
}
// turn YouTube / Google errors into plain instructions
function explainYt(e) {
  const m = String(e.message || '');
  if (e.code === 'invalid_grant' || /invalid_grant|expired or revoked/i.test(m))
    return 'Google rejected the stored login. Check: (1) Railway GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are the SAME pair used to make the token, (2) you clicked Deploy after changing the variables, (3) the token was pasted with no spaces or quotes, (4) the Google app is "In production". See the bot logs for details.';
  if (e.code === 'invalid_client' || /invalid_client/i.test(m))
    return 'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in Railway is wrong. Use the pair that made the refresh token.';
  if (/Google login failed/i.test(m) && !process.env.GOOGLE_REFRESH_TOKEN) return 'GOOGLE_REFRESH_TOKEN is not set in Railway.';
  if (e.reason === 'liveStreamingNotEnabled' || /not enabled for live streaming/i.test(m))
    return 'This YouTube channel is not enabled for live streaming. Turn it on at youtube.com/features (it can take up to 24 hours).';
  if (e.reason === 'accessNotConfigured' || /has not been used in project|is disabled/i.test(m))
    return 'The YouTube Data API v3 is not enabled in your Google Cloud project. Enable it, wait a few minutes, then try again.';
  if (e.reason === 'quotaExceeded' || /quota/i.test(m)) return "YouTube's daily limit is used up. It resets at midnight Pacific time.";
  if (e.reason === 'insufficientPermissions' || /insufficient/i.test(m))
    return 'The Google login does not have YouTube permission. Run get-google-token.js again and allow YouTube.';
  return m || 'YouTube request failed';
}
const FIXED_DESCRIPTION = `WHAT AN AMAZING SCRIM FROM BOTH OF OUR INCREDIBLE TEAMS! 🔥

A HUGE thank you to our commentators, caster, and referee for making this match absolutely incredible to watch and play!

If you want to see more intense and competitive matches, make sure to SUBSCRIBE! You can also join our Discord for much more information, including how to apply a team to compete in MMM or even find a team to join!

🔗 Discord:  https://discord.gg/mmml

JOIN TODAY!

BE THE BEST AND ONLY THE BEST.`;
const tidy = (v, d) => String(v || d).replace(/[<>\n\r]/g, '').trim().slice(0, 30) || d;

app.post('/yt/start', needKey, async (req, res) => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(String(req.body.userId)).catch(() => null);
    if (!member || !hasRole(member, CASTER)) return res.status(403).json({ error: 'Only casters can start a stream.' });
    const t1 = tidy(req.body.team1, 'Team 1'), t2 = tidy(req.body.team2, 'Team 2');
    const title = `${t1} vs ${t2} | Monke Monke Monke | ${tidy(req.body.round, 'Bracket Round 1')}`;

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

    // post the live link in the channel you set (LIVE_CHANNEL_ID); if none is set, in the voice channel's chat
    // Discord post:   @MatchPing   then a big heading "TEAM vs TEAM" that links to the live
    await guild.roles.fetch().catch(() => {});
    const pingRole = process.env.MATCH_PING_ROLE_ID ? guild.roles.cache.get(process.env.MATCH_PING_ROLE_ID)
      : guild.roles.cache.find(r => r.name.trim().toLowerCase() === 'matchping');
    const linkText = `${t1} vs ${t2}`.replace(/[\[\]()]/g, '');
    const liveMsg = `${pingRole ? `<@&${pingRole.id}>` : '@MatchPing'}\n# [${linkText}](https://www.youtube.com/watch?v=${b.id})`;
    const target = process.env.LIVE_CHANNEL_ID ? await client.channels.fetch(process.env.LIVE_CHANNEL_ID).catch(() => null)
      : (vcChannel ? guild.channels.cache.get(vcChannel) : null);
    if (target?.send) await target.send({ content: liveMsg, allowedMentions: { roles: pingRole ? [pingRole.id] : [] } }).catch(console.error);
    res.json({ title, streamKey: stream.cdn.ingestionInfo.streamName, thumbOk: tr.ok });
  } catch (e) { console.error('YouTube start failed:', e.message, e.reason || e.code || ''); res.status(500).json({ error: explainYt(e) }); }
});

// ---------- app updates: the apps ask the bot, the bot reads your latest GitHub release ----------
// Attach BOTH files to each release: MMMOfficialApp.exe and MMMMatchTimer.exe. Set GITHUB_REPO (owner/name),
// plus GITHUB_TOKEN if the repo is private (the .exe files are then never public).
const ghHeaders = (accept) => ({ Accept: accept, 'User-Agent': 'mmm-bot', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) });
let relCache = { at: 0, data: null };
async function latestRelease() {
  if (relCache.data && Date.now() - relCache.at < 60000) return relCache.data;
  if (!process.env.GITHUB_REPO) throw new Error('GITHUB_REPO is not set on the bot.');
  const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/releases/latest`, { headers: ghHeaders('application/vnd.github+json') });
  if (!r.ok) throw new Error(`Could not read the latest release (${r.status}).`);
  const j = await r.json();
  relCache = { at: Date.now(), data: { version: String(j.tag_name).replace(/^v/i, ''), notes: j.body || '', assets: j.assets || [] } };
  return relCache.data;
}
app.get('/update/latest', needKey, async (req, res) => {
  try { const r = await latestRelease(); res.json({ version: r.version, notes: r.notes }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/update/download', needKey, async (req, res) => {
  try {
    const { assets } = await latestRelease();
    const want = req.query.file === 'timer' ? /matchtimer/i : /officialapp/i;
    const asset = assets.find(a => /\.exe$/i.test(a.name) && want.test(a.name));
    if (!asset) return res.status(404).json({ error: `The latest release has no ${req.query.file === 'timer' ? 'MMMMatchTimer.exe' : 'MMMOfficialApp.exe'} attached.` });
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
    // Read every post that has match details AND its scheduled time. Scrims that already finished are skipped, so the script
    // always uses the next / current scrim (not an old one that happens to be the newest message).
    const windowMs = (Number(process.env.SCRIM_WINDOW_HOURS) || 3) * 3600 * 1000, now = Date.now();
    const cands = [];
    for (const m of msgs.values()) {
      const embeds = m.embeds.map(e => [e.title, e.description, ...(e.fields || []).map(f => `${f.name}: ${f.value}`)].filter(Boolean).join('\n')).join('\n');
      const o = { comm: [], team1: null, team2: null, ref: null, caster: null };
      parseMatchText(`${m.cleanContent}\n${embeds}`, o);
      if (!(o.team1 || o.team2 || o.comm.length || o.ref || o.caster)) continue;
      const t = extractTimes(`${m.content}\n${embeds}`);
      cands.push({ m, o, when: t.length ? t[0] * 1000 : null });
    }
    const live = cands.filter(x => x.when == null || x.when + windowMs > now);
    live.sort((x, y) => (x.when == null ? 1 : 0) - (y.when == null ? 1 : 0) || Math.abs((x.when ?? now) - now) - Math.abs((y.when ?? now) - now));
    const pick = live[0] || null;
    let used = null, usedWhen = null;
    if (pick) { Object.assign(out, pick.o); used = pick.m; usedWhen = pick.when ? new Date(pick.when).toISOString() : null; }
    const allFinished = !pick && cands.length > 0;
    const sample = used ? null : String(msgs.first()?.cleanContent || '(no text - is Message Content Intent on?)').slice(0, 140);
    res.json({ commentators: [out.comm[0] || null, out.comm[1] || null], team1: canonTeam(out.team1), team2: canonTeam(out.team2), ref: out.ref, caster: out.caster,
      channel: ch.name, found: !!used, sample, when: usedWhen, allFinished, lineups: Object.fromEntries([...lineups].map(([k, v]) => [k, v.players])) });
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

// ---------- teams: names, colors (Google Sheet) and Discord role tracking ----------
// [full name, short name]. The bot understands BOTH everywhere (sheet rows, role names, the assignments channel).
const TEAMS = [
  ['ACID', 'ACID'], ['Get Hawked', 'GH'], ['Party Hat Pirates', 'PHP'], ['Cursed Kats', 'CK'], ['FEAR', 'FEAR'], ['Ruthless', 'RL'],
  ['Dare Devil', 'DD'], ['HOP', 'HOP'], ['Killer Dolphin', 'KD'], ['Yacer Yacer Yacer', 'YYY'], ['Faithfull Monkeys', 'FM'],
  ['Electronic Tree Troopers', 'ETT'], ['Angry Monkes', 'AM'], ['The European Monkeys', 'TEM'], ['Energy', 'NRG'], ['Zodiac', 'ZODI'],
  ['Zero Tolerance', 'ZT'], ['Gelato', 'GATO'], ['Suppression', 'SUP'], ['Overly Competitive Monkeys', 'OCM'], ['Speedy Monkeys Jay', 'SMJ'],
  ['Sleepy', 'SLPY'], ['Competitive Intelligence Agency', 'CIA'], ['EVNY', 'EVNY'], ['Sexy Gorillas', 'SG'], ['Pure', 'Pure'],
  ['Varsity', 'VAR'], ['Fate', 'Fate']
];
const normKey = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const canonTeam = (name) => { if (!name) return name; const k = normKey(name); const t = TEAMS.find(([f, sh]) => normKey(f) === k || normKey(sh) === k); return t ? t[0] : name; };

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
// Column A = team name (full OR short), Column B = hex color. The sheet must be shared as "Anyone with the link can view".
async function loadSheetColors() {
  const id = process.env.TEAMS_SHEET_ID || '1aSA3Etwlnjt_33G7Dn_356YcCmRuC8za9uI8PGvLgBw', gid = process.env.TEAMS_SHEET_GID || '0';
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`, { signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  if (!r.ok || /^\s*</.test(text)) throw new Error('the sheet is not shared publicly (set it to "Anyone with the link can view")');
  const colors = new Map();
  for (const [a, b] of parseCsv(text)) {
    const hex = String(b || '').trim();
    if (a && /^#?[0-9a-f]{6}$/i.test(hex)) colors.set(normKey(a), hex.startsWith('#') ? hex.toLowerCase() : '#' + hex.toLowerCase());
  }
  return colors;
}

let teamCache = { at: 0, data: null }; const lastStatus = new Map(); let membersLoaded = false;
async function notifyTeam(t) {
  const text = `⚠️ Team **${t.name}** was ${t.status === 'deleted' ? 'deleted' : 'disbanded'} (its Discord role ${t.status === 'deleted' ? 'is gone' : 'has no members'}). It was removed from the Match Timer team list.`;
  console.log(text);
  if (process.env.TEAM_LOG_CHANNEL_ID) { const ch = await client.channels.fetch(process.env.TEAM_LOG_CHANNEL_ID).catch(() => null); if (ch?.send) await ch.send(text).catch(console.error); }
}
async function getTeams(force = false) {
  if (!force && teamCache.data && Date.now() - teamCache.at < 60000) return teamCache.data;
  let colors = new Map(), sheetError = null;
  try { colors = await loadSheetColors(); } catch (e) { sheetError = e.message; console.error('Teams sheet:', e.message); }
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.roles.fetch();
  if (!membersLoaded) { await guild.members.fetch(); membersLoaded = true; } // once; the gateway keeps the cache up to date
  const list = TEAMS.map(([name, short]) => {
    const keys = [normKey(name), normKey(short)];
    const role = guild.roles.cache.find(r => keys.includes(normKey(r.name)));
    const status = !role ? 'deleted' : role.members.size === 0 ? 'disbanded' : 'active';
    return { name, short, color: colors.get(normKey(name)) || colors.get(normKey(short)) || null, status };
  });
  // If NO team role matches at all, the role names don't follow the team names, so don't hide anything.
  const tracked = list.some(t => t.status !== 'deleted');
  for (const t of list) {
    const prev = lastStatus.get(t.name);
    if (tracked && prev === 'active' && t.status !== 'active') notifyTeam(t).catch(console.error);
    lastStatus.set(t.name, t.status);
  }
  teamCache = { at: Date.now(), data: { teams: list, tracked, sheetError } };
  return teamCache.data;
}
app.get('/teams', needKey, async (req, res) => {
  try {
    // answer instantly from the cache and refresh in the background, so the app never waits on Discord or the sheet
    if (req.query.refresh === '1') await getTeams(true);
    else if (teamCache.data && Date.now() - teamCache.at > 60000) getTeams(true).catch(() => {});
    const d = teamCache.data || await Promise.race([getTeams(), new Promise(r => setTimeout(() => r(null), 8000))]);
    if (!d) return res.json({ teams: TEAMS.map(([name, short]) => ({ name, short, color: null })), tracked: false, sheetError: 'still loading, try Reload in a moment', removed: [] });
    const visible = d.tracked ? d.teams.filter(t => t.status === 'active') : d.teams;
    res.json({ teams: visible.map(({ name, short, color }) => ({ name, short, color })), tracked: d.tracked, sheetError: d.sheetError,
      removed: d.tracked ? d.teams.filter(t => t.status !== 'active').map(t => ({ name: t.name, status: t.status })) : [] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load the teams.' }); }
});
client.on('roleDelete', () => { teamCache.at = 0; getTeams(true).catch(() => {}); }); // a team role was deleted: re-check right away

// ---------- casting mod: only MMM Officials can get it, and it is never a file you can copy ----------
// Attach MMMOfficialCastingMod.dll to the GitHub release. The app asks for it here; the bot checks the Discord role first.
async function requireOfficial(req, res) {
  const uid = String(req.query.userId || (req.body && req.body.userId) || '');
  const guild = await client.guilds.fetch(GUILD_ID);
  const member = uid ? await guild.members.fetch(uid).catch(() => null) : null;
  if (!member || !hasRole(member, [...CASTER, ...COMMENTATOR])) { res.status(403).json({ error: 'The casting mod is only for MMM Officials.' }); return null; }
  return member;
}
app.get('/mod/payload', needKey, async (req, res) => {
  try {
    if (!await requireOfficial(req, res)) return;
    const { assets } = await latestRelease();
    const asset = assets.find(a => /castingmod/i.test(a.name) && /\.dll$/i.test(a.name));
    if (!asset) return res.status(404).json({ error: 'The latest release has no MMMOfficialCastingMod.dll attached.' });
    const r = await fetch(asset.url, { headers: ghHeaders('application/octet-stream'), redirect: 'follow' });
    if (!r.ok) return res.status(500).json({ error: `Could not download the casting mod (${r.status}).` });
    res.setHeader('Content-Type', 'application/octet-stream');
    if (asset.size) res.setHeader('Content-Length', asset.size);
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// The MMM preset: only the user IDs in PRESET_ADMIN_IDS (Banner) can save it; every official's mod loads it automatically.
const PRESET_FILE = process.env.PRESET_FILE || path.join(__dirname, 'preset.json');
let presetState = { version: '0', preset: null };
try { presetState = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8')); } catch {}
const presetAdmins = () => (process.env.PRESET_ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
app.get('/preset/get', needKey, async (req, res) => {
  try {
    if (!await requireOfficial(req, res)) return;
    res.json({ version: presetState.version, preset: presetState.preset, canEdit: presetAdmins().includes(String(req.query.userId)) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load the preset.' }); }
});
app.post('/preset/set', needKey, async (req, res) => {
  try {
    if (!presetAdmins().includes(String(req.body.userId))) return res.status(403).json({ error: 'Only Banner can save the MMM preset.' });
    const p = req.body.preset;
    if (!p || typeof p !== 'object' || JSON.stringify(p).length > 4000) return res.status(400).json({ error: 'That preset is not valid.' });
    presetState = { version: String(Date.now()), preset: p };
    try { fs.writeFileSync(PRESET_FILE, JSON.stringify(presetState)); } catch (e) { console.error('Could not save the preset file:', e.message); }
    res.json({ ok: true, version: presetState.version });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not save the preset.' }); }
});

client.once('ready', async () => {
  console.log(`Bot online as ${client.user.tag}`);
  console.log(`Google config: client id starts ${envClean('GOOGLE_CLIENT_ID').slice(0, 12)}... | secret length ${envClean('GOOGLE_CLIENT_SECRET').length} | refresh token length ${refreshTokenClean().length} (starts "${refreshTokenClean().slice(0, 4)}")`);
  try { await (await client.guilds.fetch(GUILD_ID)).commands.set([lineUpCommand.toJSON()]); console.log('Slash command /line-up registered'); }
  catch (e) { console.error('Could not register /line-up:', e.message); }
  getTeams(true).catch((e) => console.error('Teams:', e.message)); setInterval(() => getTeams(true).catch(() => {}), 10 * 60 * 1000);
  app.listen(PORT, () => console.log(`API on :${PORT}`));
});
client.login(DISCORD_TOKEN);
