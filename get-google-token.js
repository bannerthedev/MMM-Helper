// Run ONCE on your own PC:  node get-google-token.js
// Sign in with the Google account that owns the MMM YouTube channel, then put the printed token in Railway as GOOGLE_REFRESH_TOKEN.
require('dotenv').config();
const http = require('http');
const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET, redirect = 'http://127.0.0.1:53684/cb';
if (!id || !secret) { console.log('Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in bot/.env first.'); process.exit(1); }
const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code',
  access_type: 'offline', prompt: 'consent', scope: 'https://www.googleapis.com/auth/youtube' });
console.log('\nOpen this link in your browser and sign in with the YouTube channel account:\n\n' + url + '\n');
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect); if (u.pathname !== '/cb') return res.end();
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ code: u.searchParams.get('code'),
    client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }) });
  const j = await r.json(); res.end(j.refresh_token ? 'Done. Go back to the terminal.' : 'Failed. See the terminal.');
  console.log(j.refresh_token ? '\nGOOGLE_REFRESH_TOKEN=' + j.refresh_token + '\n' : '\nNo refresh token returned: ' + JSON.stringify(j));
  srv.close(); process.exit(0);
}).listen(53684, '127.0.0.1');
