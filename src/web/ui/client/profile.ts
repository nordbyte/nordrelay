function applyAccountChrome(auth){
  state.auth=auth||state.auth;
  const user=auth?.user||{};
  const name=user.displayName||user.email||'Account';
  const initials=accountInitials(name);
  const nameEl=document.getElementById('userMenuName');
  const initialsEl=document.getElementById('userMenuInitials');
  if(nameEl)nameEl.textContent=name;
  if(initialsEl)initialsEl.textContent=initials;
  const accountTheme=user.preferences?.theme;
  applyThemePreference(accountTheme||savedThemePreference(),{persist:Boolean(accountTheme)});
}

function accountInitials(value){
  const parts=String(value||'').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if(!parts.length)return'?';
  return (parts[0][0]+(parts[1]?.[0]||parts[0][1]||'')).toUpperCase();
}

function setUserMenuOpen(open){
  const panel=document.getElementById('userMenuPanel');
  const button=document.getElementById('userMenuBtn');
  if(panel)panel.hidden=!open;
  if(button)button.setAttribute('aria-expanded',open?'true':'false');
}

async function setAccountTheme(preference){
  const theme=normalizeThemePreference(preference);
  applyThemePreference(theme);
  if(state.auth?.user){
    try{
      const profile=await api('/api/profile',{method:'PATCH',body:{preferences:{theme}},local:true});
      state.profile=profile;
      applyAccountChrome({user:profile.user,groups:profile.groups,permissions:profile.permissions,csrfToken:state.csrfToken});
      toast('Theme saved');
    }catch(error){
      toast(error.message||String(error));
    }
  }
}

async function openProfileDialog(){
  const dialog=document.getElementById('profileDialog');
  if(!dialog)return;
  await loadProfile();
  dialog.showModal();
}

async function loadProfile(){
  const profile=await api('/api/profile',{local:true});
  state.profile=profile;
  state.auth={...(state.auth||{}),user:profile.user,groups:profile.groups,permissions:profile.permissions,csrfToken:state.csrfToken};
  state.permissions=profile.permissions||state.permissions;
  applyAccountChrome(state.auth);
  document.getElementById('profileEmail').value=profile.user.email||'';
  document.getElementById('profileNameInput').value=profile.user.displayName||'';
  document.getElementById('profileThemeSelect').value=normalizeThemePreference(profile.user.preferences?.theme||savedThemePreference());
  renderProfileLinkedAccounts(profile);
  renderProfileSecurity(profile);
  renderProfileApiTokens(profile);
  renderProfileWebSessions(profile);
  document.getElementById('profileStatus').textContent='';
  document.getElementById('profilePasswordStatus').textContent='';
  document.getElementById('profileSecurityStatus').textContent='';
  document.getElementById('profileApiTokenResult').textContent='';
}

function renderProfileLinkedAccounts(profile){
  const box=document.getElementById('profileLinkedAccounts');
  if(!box)return;
  const rows=[];
  for(const identity of profile.telegramIdentities||[]){
    rows.push(profileListItem('Telegram',[
      ['User ID',String(identity.telegramUserId)],
      ['Username',identity.username||'-'],
      ['Linked',fmtDate(identity.linkedAt)],
      ['Status',identity.active?'active':'disabled'],
    ]));
  }
  for(const identity of profile.discordIdentities||[]){
    rows.push(profileListItem('Discord',[
      ['User ID',identity.discordUserId],
      ['Username',identity.globalName||identity.username||'-'],
      ['Linked',fmtDate(identity.linkedAt)],
      ['Status',identity.active?'active':'disabled'],
    ]));
  }
  for(const identity of profile.slackIdentities||[]){
    rows.push(profileListItem('Slack',[
      ['User ID',identity.slackUserId],
      ['Team',identity.teamId||'-'],
      ['Username',identity.realName||identity.username||'-'],
      ['Linked',fmtDate(identity.linkedAt)],
      ['Status',identity.active?'active':'disabled'],
    ]));
  }
  for(const identity of profile.matrixIdentities||[]){
    rows.push(profileListItem('Matrix',[
      ['User ID',identity.matrixUserId],
      ['Homeserver',identity.homeserver||'-'],
      ['Display name',identity.displayName||'-'],
      ['Linked',fmtDate(identity.linkedAt)],
      ['Status',identity.active?'active':'disabled'],
    ]));
  }
  box.innerHTML=rows.join('')||'<div class="item empty-state">No linked chat accounts.</div>';
}

function renderProfileWebSessions(profile){
  const box=document.getElementById('profileWebSessions');
  if(!box)return;
  const rows=(profile.webSessions||[]).map(session=>{
    const current=session.id===profile.currentSessionId;
    return profileListItem(current?'Current session':'Web session',[
      ['Created',fmtDate(session.createdAt)],
      ['Last seen',fmtDate(session.lastSeenAt)],
      ['Expires',fmtDate(session.expiresAt)],
      ['Device',session.deviceName||'-'],
      ['IP',session.ipAddress||'-'],
      ['MFA',session.mfaVerified?'verified':'not verified'],
      ['ID',session.id],
    ],current?'enabled':'disabled')+(current?'':'<div class="row"><button class="danger" data-profile-session-revoke="'+attr(session.id)+'">Revoke session</button></div>');
  });
  box.innerHTML=rows.join('')||'<div class="item empty-state">No active web sessions.</div>';
  box.querySelectorAll('[data-profile-session-revoke]').forEach(button=>button.addEventListener('click',event=>safe(()=>revokeProfileSession(button.dataset.profileSessionRevoke),event)));
}

function renderProfileSecurity(profile){
  const box=document.getElementById('profileSecurity');
  if(!box)return;
  const mfa=profile.mfa||{};
  const rows=[];
  rows.push(profileListItem('Authenticator app',[
    ['Status',mfa.totpEnabled?'enabled':'disabled'],
    ['Recovery codes remaining',String(mfa.recoveryCodesRemaining||0)],
  ],mfa.totpEnabled?'enabled':'disabled')+'<div class="row">'+
    (mfa.totpEnabled?'<button type="button" class="secondary" data-profile-recovery>Regenerate recovery codes</button><button type="button" class="danger" data-profile-totp-disable>Disable authenticator</button>':'')+
    '</div>');
  const passkeys=(mfa.webAuthnCredentials||[]).map(credential=>profileListItem(credential.name||'Passkey',[
    ['Created',fmtDate(credential.createdAt)],
    ['Last used',fmtDate(credential.lastUsedAt)],
    ['ID',credential.id],
  ],'enabled')+'<div class="row"><button type="button" class="danger" data-profile-passkey-delete="'+attr(credential.id)+'">Remove passkey</button></div>').join('');
  rows.push('<div class="item"><strong>Passkeys</strong><div class="row"><button type="button" class="secondary" data-profile-passkey-add>Add passkey</button></div></div>'+(passkeys||'<div class="item empty-state">No passkeys registered.</div>'));
  box.innerHTML=rows.join('');
  box.querySelector('[data-profile-totp-disable]')?.addEventListener('click',event=>safe(disableProfileTotp,event));
  box.querySelector('[data-profile-recovery]')?.addEventListener('click',event=>safe(regenerateProfileRecoveryCodes,event));
  box.querySelector('[data-profile-passkey-add]')?.addEventListener('click',event=>safe(registerProfilePasskey,event));
  box.querySelectorAll('[data-profile-passkey-delete]').forEach(button=>button.addEventListener('click',event=>safe(()=>deleteProfilePasskey(button.dataset.profilePasskeyDelete),event)));
}

function renderProfileApiTokens(profile){
  const box=document.getElementById('profileApiTokens');
  if(!box)return;
  const rows=(profile.apiTokens||[]).map(token=>profileListItem(token.name||'API token',[
    ['Prefix',token.tokenPrefix||'-'],
    ['Permissions',(token.permissions||[]).join(', ')||'-'],
    ['Agent scope',(token.agentIds||[]).join(', ')||'all'],
    ['Workspace scope',(token.workspaceRoots||[]).join(', ')||'all'],
    ['Peer scope',(token.peerIds||[]).join(', ')||'all'],
    ['Created',fmtDate(token.createdAt)],
    ['Last used',fmtDate(token.lastUsedAt)],
    ['Expires',fmtDate(token.expiresAt)],
    ['Status',token.revokedAt?'revoked':'active'],
  ],token.revokedAt?'disabled':'enabled')+(token.revokedAt?'':'<div class="row"><button type="button" class="danger" data-profile-token-revoke="'+attr(token.id)+'">Revoke token</button></div>'));
  box.innerHTML=rows.join('')||'<div class="item empty-state">No API tokens.</div>';
  box.querySelectorAll('[data-profile-token-revoke]').forEach(button=>button.addEventListener('click',event=>safe(()=>revokeProfileApiToken(button.dataset.profileTokenRevoke),event)));
}

function profileListItem(title,rows,status=''){
  const badge=status?'<span class="adapter-status '+attr(status)+'">'+esc(status==='enabled'?'current':'other')+'</span>':'';
  return '<div class="item"><strong>'+esc(title)+' '+badge+'</strong>'+rows.map(([key,value])=>'<small>'+esc(key)+': '+esc(value||'-')+'</small>').join('')+'</div>';
}

async function saveProfile(){
  const status=document.getElementById('profileStatus');
  const displayName=document.getElementById('profileNameInput').value.trim();
  const theme=normalizeThemePreference(document.getElementById('profileThemeSelect').value);
  const profile=await api('/api/profile',{method:'PATCH',body:{displayName,preferences:{theme}},local:true});
  state.profile=profile;
  state.auth={...(state.auth||{}),user:profile.user,groups:profile.groups,permissions:profile.permissions,csrfToken:state.csrfToken};
  state.permissions=profile.permissions||state.permissions;
  applyAccountChrome(state.auth);
  if(status)status.textContent='Saved';
  toast('Profile saved');
}

async function changeProfilePassword(){
  const status=document.getElementById('profilePasswordStatus');
  const currentPassword=document.getElementById('profileCurrentPassword').value;
  const newPassword=document.getElementById('profileNewPassword').value;
  const confirmPassword=document.getElementById('profileConfirmPassword').value;
  if(newPassword.length<12){if(status)status.textContent='New password must be at least 12 characters.';return}
  if(newPassword!==confirmPassword){if(status)status.textContent='New passwords do not match.';return}
  await api('/api/profile/password',{method:'POST',body:{currentPassword,newPassword},local:true});
  document.getElementById('profileCurrentPassword').value='';
  document.getElementById('profileNewPassword').value='';
  document.getElementById('profileConfirmPassword').value='';
  await loadProfile();
  if(status)status.textContent='Password changed. Other sessions were logged out.';
  toast('Password changed');
}

async function logoutOtherProfileSessions(){
  const result=await api('/api/profile/logout-other-sessions',{method:'POST',body:{},local:true});
  if(result.profile){
    state.profile=result.profile;
    renderProfileWebSessions(result.profile);
  }else{
    await loadProfile();
  }
  toast('Logged out '+(result.revoked||0)+' other session'+((result.revoked||0)===1?'':'s'));
}

async function setupProfileTotp(){
  const status=document.getElementById('profileSecurityStatus');
  const setup=await api('/api/profile/mfa/totp/setup',{method:'POST',body:{},local:true});
  const code=prompt('Scan this otpauth URL with your authenticator, then enter the 6-digit code.\\n\\n'+setup.otpauthUrl);
  if(!code)return;
  const result=await api('/api/profile/mfa/totp/enable',{method:'POST',body:{secret:setup.secret,code},local:true});
  await loadProfile();
  if(status)status.textContent='Authenticator enabled. Save these recovery codes now: '+(result.recoveryCodes||[]).join(' ');
  toast('Authenticator enabled');
}

async function disableProfileTotp(){
  if(!confirm('Disable authenticator MFA and remove recovery codes?'))return;
  await api('/api/profile/mfa/totp/disable',{method:'POST',body:{},local:true});
  await loadProfile();
  toast('Authenticator disabled');
}

async function regenerateProfileRecoveryCodes(){
  if(!confirm('Generate new recovery codes? Existing unused codes will stop working.'))return;
  const result=await api('/api/profile/mfa/recovery-codes',{method:'POST',body:{},local:true});
  await loadProfile();
  const status=document.getElementById('profileSecurityStatus');
  if(status)status.textContent='New recovery codes: '+(result.recoveryCodes||[]).join(' ');
  toast('Recovery codes regenerated');
}

async function registerProfilePasskey(){
  if(!navigator.credentials||!window.PublicKeyCredential){toast('Passkeys are not supported in this browser');return}
  const name=prompt('Passkey name','Passkey')||'Passkey';
  const setup=await api('/api/profile/webauthn/register/options',{method:'POST',body:{},local:true});
  const credential=await navigator.credentials.create({publicKey:publicKeyCreation(setup.options)});
  await api('/api/profile/webauthn/register/verify',{method:'POST',body:{challengeId:setup.challengeId,response:credentialToJson(credential),name},local:true});
  await loadProfile();
  toast('Passkey registered');
}

async function deleteProfilePasskey(id){
  if(!id||!confirm('Remove this passkey?'))return;
  await api('/api/profile/webauthn/'+encodeURIComponent(id),{method:'DELETE',body:{},local:true});
  await loadProfile();
  toast('Passkey removed');
}

async function createProfileApiToken(){
  const name=prompt('Token name','Workflow token');
  if(!name)return;
  const permissionText=prompt('Comma-separated permissions for this token','workflows.run,workflows.read');
  if(!permissionText)return;
  const result=await api('/api/profile/api-tokens',{method:'POST',body:{name,permissions:permissionText.split(',').map(v=>v.trim()).filter(Boolean)},local:true});
  await loadProfile();
  const box=document.getElementById('profileApiTokenResult');
  if(box)box.textContent='New token, shown once: '+result.token;
  toast('API token created');
}

async function revokeProfileApiToken(id){
  if(!id||!confirm('Revoke this API token?'))return;
  await api('/api/profile/api-tokens/'+encodeURIComponent(id),{method:'DELETE',body:{},local:true});
  await loadProfile();
  toast('API token revoked');
}

async function revokeProfileSession(id){
  if(!id||!confirm('Revoke this web session?'))return;
  await api('/api/profile/sessions/'+encodeURIComponent(id),{method:'DELETE',body:{},local:true});
  await loadProfile();
  toast('Session revoked');
}

function publicKeyCreation(options){
  return {
    ...options,
    challenge:b64ToBuf(options.challenge),
    user:{...options.user,id:b64ToBuf(options.user.id)},
    excludeCredentials:(options.excludeCredentials||[]).map(c=>({...c,id:b64ToBuf(c.id)})),
  };
}

function credentialToJson(credential){
  return {
    id:credential.id,
    rawId:bufToB64(credential.rawId),
    type:credential.type,
    response:{
      attestationObject:credential.response.attestationObject?bufToB64(credential.response.attestationObject):undefined,
      authenticatorData:credential.response.authenticatorData?bufToB64(credential.response.authenticatorData):undefined,
      clientDataJSON:bufToB64(credential.response.clientDataJSON),
      signature:credential.response.signature?bufToB64(credential.response.signature):undefined,
      userHandle:credential.response.userHandle?bufToB64(credential.response.userHandle):undefined,
      transports:credential.response.getTransports?credential.response.getTransports():undefined,
    },
  };
}

function b64ToBuf(value){
  const normalized=String(value||'');
  const pad='='.repeat((4-normalized.length%4)%4);
  const binary=atob((normalized+pad).replace(/-/g,'+').replace(/_/g,'/'));
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes.buffer;
}

function bufToB64(buffer){
  const bytes=new Uint8Array(buffer);
  let binary='';
  for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

document.getElementById('userMenuBtn')?.addEventListener('click',()=>setUserMenuOpen(document.getElementById('userMenuPanel')?.hidden!==false));
document.addEventListener('click',event=>{
  const menu=document.getElementById('accountMenu');
  if(menu&&!menu.contains(event.target as Node))setUserMenuOpen(false);
});
document.addEventListener('keydown',event=>{if(event.key==='Escape')setUserMenuOpen(false)});
document.getElementById('profileBtn')?.addEventListener('click',()=>safe(async()=>{setUserMenuOpen(false);await openProfileDialog()}));
document.querySelectorAll('[data-theme-choice]').forEach(button=>button.addEventListener('click',()=>safe(async()=>{setUserMenuOpen(false);await setAccountTheme(button.dataset.themeChoice)})));
document.getElementById('profileThemeSelect')?.addEventListener('change',event=>applyThemePreference(event.target.value));
document.getElementById('saveProfileBtn')?.addEventListener('click',event=>safe(saveProfile,event));
document.getElementById('changeProfilePasswordBtn')?.addEventListener('click',event=>safe(changeProfilePassword,event));
document.getElementById('logoutOtherSessionsBtn')?.addEventListener('click',event=>safe(logoutOtherProfileSessions,event));
document.getElementById('setupTotpBtn')?.addEventListener('click',event=>safe(setupProfileTotp,event));
document.getElementById('createApiTokenBtn')?.addEventListener('click',event=>safe(createProfileApiToken,event));
document.getElementById('closeProfileBtn')?.addEventListener('click',()=>document.getElementById('profileDialog')?.close());
