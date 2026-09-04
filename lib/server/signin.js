import { randomBytes } from 'node:crypto';

export function signInPage(apiKey, request) {
  const nonce = randomBytes(18).toString('base64');
  const data = JSON.stringify({ apiKey, request }).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Terrace Tank</title><style nonce="${nonce}">
body{font:17px system-ui;background:#eef6f7;color:#143336;max-width:440px;margin:8vh auto;padding:24px}main{background:white;border-radius:20px;padding:28px}h1{font-size:28px}label{display:block;margin-top:18px}input,button{box-sizing:border-box;width:100%;padding:13px;font:inherit;border:1px solid #789498;border-radius:8px}button{margin-top:24px;background:#155e63;color:white;cursor:pointer}#status{min-height:1.5em}small{display:block;margin-top:20px;line-height:1.5}
</style><main><h1>Connect Terrace Tank</h1><p>Allow Google Home to read the tank sensors registered to your account.</p><p>Google Home displays tank level using its humidity sensor format. Pump control is not available.</p>
<form id="signin"><label for="email">Account email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button id="submit">Sign in and allow access</button></form><p id="status" role="status"></p><small>You can revoke access by unlinking Terrace Tank in Google Home. Use the account created for this tank.</small></main>
<script nonce="${nonce}">
const config=${data};
document.getElementById('signin').addEventListener('submit',async event=>{
 event.preventDefault();const button=document.getElementById('submit');const status=document.getElementById('status');button.disabled=true;status.textContent='Signing in…';
 try {
  const response=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key='+encodeURIComponent(config.apiKey),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('password').value,returnSecureToken:true})});
  document.getElementById('password').value='';
  if(!response.ok)throw new Error('Sign-in failed. Check your email and password.');
  const account=await response.json();
  const link=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+account.idToken},body:JSON.stringify(config.request)});
  if(!link.ok)throw new Error('This account is not ready to link. Contact the tank owner.');
  const result=await link.json();location.assign(result.redirect);
 }catch(error){status.textContent=error.message;button.disabled=false;}
});</script></html>`;
  return { html, csp: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self' https://identitytoolkit.googleapis.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` };
}
