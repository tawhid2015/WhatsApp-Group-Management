const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const fmt = value => { const d = new Date(value); return Number.isNaN(d.getTime()) ? esc(value || '—') : d.toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}); };
const typeLabel = type => ({join:'Member joined', member_added:'Added to Sheets', leave:'Member left', auto_remove:'Auto removed', manual_remove:'Manually removed', duplicate_join:'Duplicate join', connected:'WhatsApp connected', logout:'WhatsApp logged out', disconnected:'WhatsApp disconnected', error:'System error', sheets_error:'Sheets error'}[type] || type || 'Activity');
const activityHtml = e => {
  const resultTag = e.result === 'already_absent' ? ' · already absent (not in group)' : e.result === 'failed' ? ' · FAILED' : e.result === 'success' ? '' : '';
  const label = e.type === 'auto_remove' ? (e.result === 'success' ? 'Auto removed' : e.result === 'already_absent' ? 'Expiry check · skipped' : e.result === 'failed' ? 'Auto removal failed' : 'Auto removed') : typeLabel(e.type);
  return `<div class="activity-item"><div><b>${esc(label)}${resultTag ? `<span style="color:var(--${e.result === 'failed' ? 'red' : 'muted'})">${esc(resultTag)}</span>` : ''}</b><span>${e.name ? ` · ${esc(e.name)}` : e.phone ? ` · ${esc(e.phone)}` : e.message ? ` · ${esc(e.message)}` : ''}</span></div><time>${fmt(e.at)}</time></div>`;
};

function toast(message) { const el=$('toast'); el.textContent=message; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2800); }
async function json(url, opts) { const r=await fetch(url, opts); const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(data.error || `Request failed (${r.status})`); return data; }
async function loadStats() { try { const s=await json('/api/stats'); ['total','active','expired','permanent','joinedToday','leftToday','removedToday'].forEach(k=>{ if($(k)) $(k).textContent=s[k] ?? '—'; }); $('syncTime').textContent=s.lastSync ? `Synced ${fmt(s.lastSync)}` : 'Not synced'; $('footerSync').textContent=s.lastSync ? fmt(s.lastSync) : '—'; $('checkTime').textContent=s.lastExpiryCheck ? fmt(s.lastExpiryCheck) : 'Never'; $('sheetStatus').textContent=s.syncError ? 'Error' : 'Synced'; $('warning').hidden=!s.invalid; $('warningText').textContent=s.invalid ? `${s.invalid} record(s) have no valid expiry.` : ''; } catch(e) { $('sheetStatus').textContent='Error'; toast(e.message); } }
async function loadMembers() { try { const members=await json('/api/members'); window.members=members; renderMembers(); } catch(e) { $('membersBody').innerHTML=`<tr><td colspan="6" class="empty">${esc(e.message)}</td></tr>`; } }
function renderMembers() {
  const q = ($('search').value || '').toLowerCase();
  const list = (window.members || []).filter(m => `${m.Name} ${m.Phone}`.toLowerCase().includes(q));
  if (!list.length) {
    $('membersBody').innerHTML = '<tr><td colspan="6" class="empty">No members found</td></tr>';
    return;
  }
  $('membersBody').innerHTML = list.map(m => {
    const state = (m._state || '').toLowerCase();
    const badgeClass = state.includes('removed') ? 'removed' : state.includes('permanent') ? 'permanent' : state.includes('expired') ? 'expired' : state.includes('invalid') || state.includes('no_') ? 'invalid' : 'active';
    return `<tr><td>${esc(m.Name || 'Unknown')}</td><td>${esc(m.Phone)}</td><td>${fmt(m.Joining)}</td><td>${esc(m.Expire || '—')}</td><td><span class="badge ${badgeClass}">${esc(m._state || 'ACTIVE')}</span></td><td><button class="remove" data-phone="${esc(m.Phone)}">Remove</button></td></tr>`;
  }).join('');
}
async function loadActivity() {
  try {
    const events = await json('/api/activity');
    window.allActivity = events;
    window.activityOffset = 0;
    renderActivity();
  } catch(e) {}
}

function renderActivity() {
  const list = window.allActivity || [];
  const limit = 15;
  const visible = list.slice(window.activityOffset, window.activityOffset + limit);
  $('allActivity').innerHTML = visible.map(activityHtml).join('') || '<div class="empty">No activity yet</div>';
  $('recent').innerHTML = list.slice(0,5).map(activityHtml).join('') || '<div class="empty">No activity yet</div>';
  const loadMoreBtn = $('loadMore');
  if (loadMoreBtn) {
    if (window.activityOffset + limit >= list.length) {
      loadMoreBtn.textContent = 'No more events';
      loadMoreBtn.disabled = true;
    } else {
      loadMoreBtn.textContent = `Load more (${list.length - (window.activityOffset + limit)} remaining)`;
      loadMoreBtn.disabled = false;
    }
  }
}

function clearActivity() {
  if (!confirm('Clear all activity history? This cannot be undone.')) return;
  fetch('/api/activity', { method: 'DELETE' }).then(() => {
    window.allActivity = [];
    window.activityOffset = 0;
    renderActivity();
    toast('Activity cleared');
  }).catch(() => toast('Failed to clear activity'));
}
async function loadWA() { try { const s=await json('/api/wa/status'); const label=s.status.replaceAll('_',' ').toLowerCase().replace(/^./,x=>x.toUpperCase()); ['waStatus','waStatus2','sideStatus'].forEach(id=>{if($(id))$(id).textContent=label}); ['statusDot','sideDot'].forEach(id=>{if($(id))$(id).style.background=s.connected?'var(--green)':'var(--orange)'}); } catch(e){} }
async function refresh() { await Promise.all([loadStats(),loadMembers(),loadActivity(),loadWA()]); }
$('search').addEventListener('input',renderMembers); $('refresh').addEventListener('click',()=>{refresh();toast('Dashboard refreshed')});
if ($('loadMore')) $('loadMore').addEventListener('click',()=>{ window.activityOffset += 15; renderActivity(); });
if ($('clearActivity')) $('clearActivity').addEventListener('click',clearActivity);
$('runCheck').addEventListener('click',async()=>{const b=$('runCheck');b.disabled=true;b.innerHTML='Checking…';try{const r=await json('/api/expiry/check',{method:'POST'});toast(`Checked ${r.checked} members · removed ${r.removed}`);await refresh()}catch(e){toast(e.message)}finally{b.disabled=false;b.innerHTML='Run expiry check <span>→</span>'}});
document.addEventListener('click',async e=>{const b=e.target.closest('.remove');if(!b)return;if(!confirm(`Remove ${b.dataset.phone} from WhatsApp?`))return;b.disabled=true;try{await json(`/api/members/${encodeURIComponent(b.dataset.phone)}/remove`,{method:'POST'});toast('Member removal requested');await refresh()}catch(x){toast(x.message)}finally{b.disabled=false}});
refresh(); setInterval(refresh,15000);
