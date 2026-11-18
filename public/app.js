const $ = (s) => document.querySelector(s);
const state = { user: null, data: null, page: 'overview', filter: 'all' };
const modal = $('#modal');
let toastTimer;
function toast(message, type = 'success', title) {
  const el = $('#toast');
  const labels = { success: 'Success', error: 'Something went wrong', info: 'Information', warning: 'Attention' };
  const icons = { success: '✓', error: '!', info: 'i', warning: '!' };
  el.className = 'toast toast-' + type;
  el.innerHTML = '<span class="toast-icon" aria-hidden="true">' + icons[type] + '</span><span class="toast-copy"><b>' + escapeHtml(title || labels[type] || 'Notification') + '</b><span>' + escapeHtml(message) + '</span></span><button class="toast-close" type="button" aria-label="Dismiss notification">×</button>';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), type === 'error' ? 6500 : 4200);
}
$('#toast').addEventListener('click', e => {
  if (e.target.closest('.toast-close')) $('#toast').classList.remove('show');
});
function showInfoModal(title, message, actionLabel = 'Got it') {
  $('#modal-content').innerHTML = '<h2>' + escapeHtml(title) + '</h2><p class="modal-message">' + escapeHtml(message) + '</p><button id="message-close" class="btn primary full">' + escapeHtml(actionLabel) + '</button>';
  modal.showModal();
  $('#message-close').onclick = () => modal.close();
}
function showVerificationModal(code, expiresInMinutes) {
  $('#modal-content').innerHTML = '<span class="eyebrow">WHATSAPP VERIFICATION</span><h2>Your verification code</h2><p>Send this code from the registered WhatsApp number to Andy. It can only be used once.</p><div class="verification-code">' + escapeHtml(code) + '</div><p class="verification-expiry">Expires in ' + escapeHtml(expiresInMinutes) + ' minutes</p><button id="copy-code" class="btn secondary full" type="button">Copy code</button><button id="verification-close" class="btn primary full" type="button">Done</button>';
  modal.showModal();
  $('#copy-code').onclick = async () => {
    try { await navigator.clipboard.writeText(String(code)); toast('Verification code copied', 'success'); }
    catch { toast('Select and copy the verification code manually', 'info'); }
  };
  $('#verification-close').onclick = () => modal.close();
}
function showConfirmModal(title, message, confirmLabel = 'Confirm') {
  return new Promise(resolve => {
    $('#modal-content').innerHTML = '<h2>' + escapeHtml(title) + '</h2><p class="modal-message">' + escapeHtml(message) + '</p><div class="confirm-actions"><button id="confirm-cancel" class="btn secondary" type="button">Cancel</button><button id="confirm-accept" class="btn danger" type="button">' + escapeHtml(confirmLabel) + '</button></div>';
    modal.showModal();
    let settled = false;
    const finish = value => { if (settled) return; settled = true; modal.close(); resolve(value); };
    $('#confirm-cancel').onclick = () => finish(false);
    $('#confirm-accept').onclick = () => finish(true);
    modal.addEventListener('close', () => finish(false), { once: true });
  });
}
async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function date(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
function status(value) { return '<span class="status '+escapeHtml(value)+'">'+escapeHtml(value || 'unknown')+'</span>'; }
function initials(name) { return (name || 'A').split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase(); }
function showAuth(bootstrap = false) { $('#auth-screen').classList.remove('hidden'); $('#app').classList.add('hidden'); $('#login-form').classList.toggle('hidden',bootstrap); $('#bootstrap-form').classList.toggle('hidden',!bootstrap); }
function showApp() { $('#auth-screen').classList.add('hidden'); $('#app').classList.remove('hidden'); }
function setProfile(user) { state.user=user; $('#sidebar-name').textContent=user.name; $('#sidebar-role').textContent=user.role==='admin'?'Administrator':'Member'; $('#user-avatar').textContent=initials(user.name); $('#top-avatar').textContent=initials(user.name); document.querySelectorAll('[data-admin="true"]').forEach(el=>el.classList.toggle('hidden',user.role!=='admin')); }
function navigate(page) { state.page=page; document.querySelectorAll('.page').forEach(el=>el.classList.toggle('active',el.id==='page-'+page)); document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.page===page)); $('#page-breadcrumb').textContent=({overview:'Overview',users:'Users',whatsapp:'WhatsApp profiles',linkedin:'LinkedIn accounts',mappings:'Account mappings',drafts:'Drafts & approvals',activity:'Activity log'})[page]||page; renderPage(page); }
async function refresh() { state.data=await api('/api/dashboard'); renderOverview(); }
function renderStats(s) { const items=[['Total users',s.users,'♙','Across your workspace'],['WhatsApp profiles',s.whatsappProfiles,'◉',s.activeWhatsApp+' verified'],['LinkedIn accounts',s.linkedinAccounts,'in','Connected profiles'],['Published posts',s.published,'↗','Across all accounts']]; $('#stats').innerHTML=items.map(([label,value,icon,note])=>'<div class="stat-card"><div class="stat-top">'+label+'<span class="stat-icon">'+icon+'</span></div><div class="stat-value">'+(value||0)+'</div><div class="stat-note">'+note+'</div></div>').join(''); }
function renderConnections() { const d=state.data; const wa=d.whatsappProfiles||[], li=d.linkedinAccounts||[]; const rows=[...wa.map(x=>({kind:'wa',name:x.label,sub:x.user_name||x.display_name||x.phone_jid,status:x.status})),...li.map(x=>({kind:'li',name:x.display_name,sub:x.user_name||x.member_urn,status:x.status}))]; $('#connection-list').innerHTML=rows.length?rows.slice(0,8).map(x=>'<div class="connection-row"><span class="service-icon '+x.kind+'">'+(x.kind==='wa'?'◉':'in')+'</span><div class="connection-info"><b>'+escapeHtml(x.name)+'</b><small>'+escapeHtml(x.sub||'')+'</small></div>'+status(x.status)+'</div>').join(''):'<div class="empty">No accounts connected yet. Start by adding a WhatsApp profile.</div>'; }
function renderDrafts(target, drafts) { target.innerHTML=drafts.length?drafts.map(d=>'<div class="draft-item"><div class="draft-item-head"><b>'+escapeHtml(d.linkedin_display_name||'LinkedIn account')+'</b>'+status(d.status)+'</div><div class="draft-text">'+escapeHtml(d.text)+'</div><div class="account-meta"><span>'+escapeHtml(d.source_title||'')+'</span><span>'+date(d.updated_at)+'</span></div></div>').join(''):'<div class="empty">No drafts yet. Drafts will appear here when the content workflow is connected.</div>'; }
function renderActivity(target, events) { target.innerHTML=events.length?events.map(e=>'<div class="activity-row"><span class="activity-bullet"></span><div class="activity-copy"><b>'+escapeHtml((e.action||'event').replaceAll('.',' '))+'</b><small>'+date(e.created_at)+' · '+escapeHtml(e.target_user_id||'workspace')+'</small></div></div>').join(''):'<div class="empty">No activity recorded yet.</div>'; }
function renderOverview() { const d=state.data; renderStats(d.summary||{}); renderConnections(); renderActivity($('#recent-activity'),d.audit||[]); renderDrafts($('#recent-drafts'),d.recentDrafts||[]); }
function renderUsers(users) { $('#users-count').textContent=users.length+' members'; $('#user-nav-count').textContent=users.length; $('#users-table').innerHTML=users.length?'<div class="table-wrap"><table><thead><tr><th>MEMBER</th><th>ROLE</th><th>STATUS</th><th>JOINED</th><th>ACTION</th></tr></thead><tbody>'+users.map(u=>'<tr><td><b>'+escapeHtml(u.name)+'</b><br><span class="muted-inline">'+escapeHtml(u.email)+'</span></td><td>'+escapeHtml(u.role)+'</td><td>'+status(u.status)+'</td><td>'+date(u.created_at)+'</td><td><button class="small-btn" data-toggle-user="'+u.id+'" data-status="'+u.status+'">'+(u.status==='active'?'Suspend':'Activate')+'</button></td></tr>').join('')+'</tbody></table></div>':'<div class="empty">No users yet.</div>'; }
function renderWhatsApp(profiles) { $('#whatsapp-cards').innerHTML=profiles.length?profiles.map(p=>'<article class="account-card"><div class="account-card-head"><span class="service-icon wa">◉</span><div class="connection-info"><b>'+escapeHtml(p.label)+'</b><small>'+escapeHtml(p.user_name||'')+'</small></div>'+status(p.status)+'</div><p>'+escapeHtml(p.display_name||p.phone_jid||'WhatsApp identity not verified yet')+'</p><div class="account-meta"><span>'+escapeHtml(p.phone_jid||'Phone pending')+'</span><span>'+date(p.verified_at)+'</span></div><div style="margin-top:13px"><button class="small-btn" data-challenge="'+p.id+'">Generate verification code</button></div></article>').join(''):'<div class="panel empty">No WhatsApp profiles yet. Add a WhatsApp phone identity to start verification.</div>'; }
function renderLinkedIn(accounts) { $('#linkedin-cards').innerHTML=accounts.length?accounts.map(a=>'<article class="account-card"><div class="account-card-head"><span class="service-icon li">in</span><div class="connection-info"><b>'+escapeHtml(a.display_name)+'</b><small>'+escapeHtml(a.user_name||'')+'</small></div>'+status(a.status)+'</div><p>'+escapeHtml(a.member_urn)+'</p><div class="account-meta"><span>Expires '+date(a.token_expires_at)+'</span><span>'+escapeHtml(a.scopes)+'</span></div></article>').join(''):'<div class="panel empty">No LinkedIn profiles connected. Connect a LinkedIn account using the LinkedIn account OAuth consent.</div>'; }
function renderMappings(mappings) { $('#mapping-list').innerHTML=mappings.length?mappings.map(m=>'<div class="mapping-card"><div class="mapping-side"><span class="service-icon wa">◉</span><div><b>'+escapeHtml(m.whatsapp_label||'WhatsApp')+'</b><small>'+escapeHtml(m.whatsapp_display_name||'')+'</small></div></div><span class="mapping-arrow">→</span><div class="mapping-side"><span class="service-icon li">in</span><div><b>'+escapeHtml(m.linkedin_display_name||'LinkedIn')+'</b><small>'+escapeHtml(m.user_name||'')+'</small></div></div><div>'+ (m.is_default?'<span class="status active">Default</span>':'<button class="danger-link" data-delete-mapping="'+m.id+'">Remove</button>')+'</div></div>').join(''):'<div class="empty">No account mappings yet. Map a verified WhatsApp identity to a LinkedIn profile.</div>'; }
async function renderPage(page) { if(page==='overview')return renderOverview(); if(page==='users'){const r=await api('/api/users');renderUsers(r.users)} if(page==='whatsapp')renderWhatsApp(state.data.whatsappProfiles||[]); if(page==='linkedin')renderLinkedIn(state.data.linkedinAccounts||[]); if(page==='mappings')renderMappings(state.data.mappings||[]); if(page==='drafts'){const r=await api('/api/drafts');const ds=state.filter==='all'?r.drafts:r.drafts.filter(x=>x.status===state.filter);renderDrafts($('#draft-list'),ds)} if(page==='activity'&&state.user.role==='admin'){const r=await api('/api/users');renderActivity($('#activity-list'),state.data.audit||[]);}}
function openModal(title, subtitle, fields, submitText, onSubmit) { $('#modal-content').innerHTML='<h2>'+title+'</h2><p>'+subtitle+'</p>'+fields.map(f=>'<label>'+f.label+(f.type==='select'?'<select id="field-'+f.id+'">'+f.options.map(o=>'<option value="'+o.value+'">'+o.label+'</option>').join('')+'</select>':'<input id="field-'+f.id+'" type="'+(f.type||'text')+'" placeholder="'+(f.placeholder||'')+'" '+(f.required===false?'':'required')+'>')+'</label>').join('')+'<button id="modal-submit" class="btn primary full">'+submitText+' →</button>'; modal.showModal(); $('#modal-submit').onclick=async()=>{try{const values={};fields.forEach(f=>values[f.id]=$('#field-'+f.id).value);await onSubmit(values);modal.close();await refresh();await renderPage(state.page);toast('Saved successfully');}catch(e){toast(e.message, 'error')}}; }
$('#login-btn').onclick=async()=>{try{const r=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:$('#login-email').value,password:$('#login-password').value})});setProfile(r.user);showApp();await refresh();}catch(e){toast(e.message, 'error')}};
$('#show-bootstrap').onclick=()=>showAuth(true);$('#show-login').onclick=()=>showAuth(false);
$('#bootstrap-btn').onclick=async()=>{try{await api('/api/auth/bootstrap',{method:'POST',body:JSON.stringify({setupKey:$('#setup-key').value,name:$('#admin-name').value,email:$('#admin-email').value,password:$('#admin-password').value})});toast('Administrator created. Sign in to continue.');showAuth(false)}catch(e){toast(e.message, 'error')}};
$('#logout-btn').onclick=async()=>{await api('/api/auth/logout',{method:'POST'});state.user=null;showAuth(false)};
$('#refresh-btn').onclick=async()=>{try{await refresh();await renderPage(state.page);toast('Workspace refreshed')}catch(e){toast(e.message, 'error')}};
$('#navigation').onclick=e=>{const btn=e.target.closest('[data-page]');if(btn&&!btn.classList.contains('hidden'))navigate(btn.dataset.page)};
document.body.addEventListener('click',e=>{const go=e.target.closest('[data-go]');if(go)navigate(go.dataset.go)});
$('#add-user-btn').onclick=()=>openModal('Add workspace user','Create a separate member workspace.',[{id:'name',label:'Full name',placeholder:'Alex Morgan'},{id:'email',label:'Email address',type:'email'},{id:'password',label:'Temporary password (12+ characters)',type:'password'},{id:'role',label:'Role',type:'select',options:[{value:'member',label:'Member'},{value:'admin',label:'Administrator'}]}],'Create user',v=>api('/api/users',{method:'POST',body:JSON.stringify(v)}));
$('#users-table').onclick=async e=>{const b=e.target.closest('[data-toggle-user]');if(!b)return;try{await api('/api/users/'+b.dataset.toggleUser,{method:'PATCH',body:JSON.stringify({status:b.dataset.status==='active'?'suspended':'active'})});await renderPage('users');toast('User updated')}catch(err){toast(err.message, 'error')}};
$('#add-wa-btn').onclick=()=>openModal('Add WhatsApp profile','Register a WhatsApp number for a user. They will receive a one-time verification code.',[{id:'label',label:'Profile label',placeholder:'WhatsApp — Alex'},{id:'phone',label:'WhatsApp phone (with country code)',placeholder:'923001234567',required:true},{id:'userId',label:'Assign to user ID (admin only)',placeholder:'Leave blank for your own profile',required:false}],'Create profile',v=>api('/api/whatsapp-profiles',{method:'POST',body:JSON.stringify({...v,userId:v.userId||undefined})}));
$('#whatsapp-cards').onclick=async e=>{const b=e.target.closest('[data-challenge]');if(!b)return;try{const r=await api('/api/whatsapp-profiles/'+b.dataset.challenge+'/challenge',{method:'POST'});showVerificationModal(r.code, r.expiresInMinutes);}catch(err){toast(err.message, 'error')}};
$('#add-mapping-btn').onclick=()=>{const wa=state.data.whatsappProfiles.filter(x=>x.status==='active'),li=state.data.linkedinAccounts.filter(x=>x.status==='active');if(!wa.length||!li.length)return toast('Connect and verify a WhatsApp profile and LinkedIn account first');openModal('Create account mapping','Both accounts must belong to the same user.',[{id:'whatsappProfileId',label:'WhatsApp profile',type:'select',options:wa.map(x=>({value:x.id,label:x.label+' — '+(x.user_name||'')}))},{id:'linkedinAccountId',label:'LinkedIn account',type:'select',options:li.map(x=>({value:x.id,label:x.display_name+' — '+(x.user_name||'')}))},{id:'isDefault',label:'Default route',type:'select',options:[{value:'true',label:'Yes'},{value:'false',label:'No'}]}],'Create mapping',v=>api('/api/mappings',{method:'POST',body:JSON.stringify({...v,isDefault:v.isDefault==='true'})}));};
$('#mapping-list').onclick=async e=>{const b=e.target.closest('[data-delete-mapping]');if(!b)return;if(!await showConfirmModal('Remove account mapping?','This will remove the route between the WhatsApp profile and LinkedIn account.','Remove mapping'))return;try{await api('/api/mappings/'+b.dataset.deleteMapping,{method:'DELETE'});await refresh();toast('Mapping removed','success')}catch(err){toast(err.message,'error')}};
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));renderPage('drafts')});
$('#help-link').onclick=e=>{e.preventDefault();showInfoModal('Quick connection guide','1. Add a WhatsApp profile for a user. 2. Verify the identity using the shared Andy number. 3. Connect LinkedIn through the LinkedIn account OAuth consent. 4. Map the verified WhatsApp identity to one or more LinkedIn accounts. 5. Drafts and approvals are scoped to the mapped account.')};
document.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-password-toggle]');
  if (!toggle) return;
  const input = document.getElementById(toggle.dataset.passwordToggle);
  if (!input) return;
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  toggle.textContent = reveal ? 'Hide' : 'Show';
  toggle.setAttribute('aria-label', (reveal ? 'Hide ' : 'Show ') + (input.id === 'setup-key' ? 'setup key' : 'password'));
  toggle.setAttribute('aria-pressed', String(reveal));
});

async function boot(){try{const r=await api('/api/auth/me');setProfile(r.user);showApp();await refresh();navigate('overview')}catch{showAuth(false)}}
boot();
