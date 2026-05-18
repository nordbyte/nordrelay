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
  renderProfileWebSessions(profile);
  document.getElementById('profileStatus').textContent='';
  document.getElementById('profilePasswordStatus').textContent='';
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
      ['ID',session.id],
    ],current?'enabled':'disabled');
  });
  box.innerHTML=rows.join('')||'<div class="item empty-state">No active web sessions.</div>';
}

function profileListItem(title,rows,status){
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

document.getElementById('userMenuBtn')?.addEventListener('click',()=>setUserMenuOpen(document.getElementById('userMenuPanel')?.hidden!==false));
document.addEventListener('click',event=>{
  const menu=document.getElementById('accountMenu');
  if(menu&&!menu.contains(/** @type {Node} */ (event.target)))setUserMenuOpen(false);
});
document.addEventListener('keydown',event=>{if(event.key==='Escape')setUserMenuOpen(false)});
document.getElementById('profileBtn')?.addEventListener('click',()=>safe(async()=>{setUserMenuOpen(false);await openProfileDialog()}));
document.querySelectorAll('[data-theme-choice]').forEach(button=>button.addEventListener('click',()=>safe(async()=>{setUserMenuOpen(false);await setAccountTheme(button.dataset.themeChoice)})));
document.getElementById('profileThemeSelect')?.addEventListener('change',event=>applyThemePreference(event.target.value));
document.getElementById('saveProfileBtn')?.addEventListener('click',event=>safe(saveProfile,event));
document.getElementById('changeProfilePasswordBtn')?.addEventListener('click',event=>safe(changeProfilePassword,event));
document.getElementById('logoutOtherSessionsBtn')?.addEventListener('click',event=>safe(logoutOtherProfileSessions,event));
document.getElementById('closeProfileBtn')?.addEventListener('click',()=>document.getElementById('profileDialog')?.close());
