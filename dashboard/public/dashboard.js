import { projectCampaigns } from './project-catalog.js';

if(typeof document!=='undefined') {
const root=document.getElementById('campaign-preview');
const q=selector=>root.querySelector(selector);
const state={data:null,repo:'',filter:'open',selected:null,detail:null,lastSuccess:null,listError:false,detailError:false};
let listGeneration=0,detailGeneration=0;
const labels={DRAFT:'Draft',ORIENTING:'Orienting',READY:'Ready',EXECUTING:'Executing',VERIFYING:'Verifying',CLOSING:'Closing',WAITING_OWNER:'Waiting for you',BLOCKED:'Blocked',PAUSED:'Paused',FAILED:'Failed',CLOSED:'Closed',CLOSED_QUALIFIED:'Closed (qualified)',ABORTED:'Abandoned'};
const fullDate=new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short'});
function node(tag,className,text) {const item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=String(text);return item;}
function date(value) {return value&&!Number.isNaN(Date.parse(value))?fullDate.format(new Date(value)):'No date recorded';}
function age(value) {
  const time=Date.parse(value);if(Number.isNaN(time))return 'Unknown';
  const minutes=Math.max(0,Math.floor((Date.now()-time)/60000));
  if(minutes<1)return 'Just now';if(minutes<60)return `${minutes} min ago`;
  if(minutes<1440)return `${Math.floor(minutes/60)} hours ago`;
  return `${Math.floor(minutes/1440)} days ago`;
}
function badge(status) {
  const kind=['EXECUTING','VERIFYING','CLOSING'].includes(status)?'executing':status==='WAITING_OWNER'?'waiting':['BLOCKED','FAILED'].includes(status)?'blocked':'';
  const item=node('span',`cp-status ${kind}`);item.append(node('span','cp-status-dot'),node('span','',labels[status]??status));return item;
}
function phaseText(phase) {return typeof phase==='string'?phase:phase?.phase_id??'No phase recorded';}
function groupName(repo) {return repo.name;}
function matched() {return (state.data?.campaigns??[]).filter(c=>(!state.repo||c.projected_repositories.some(r=>r.key===state.repo))&&(state.filter==='all'||(state.filter==='open'&&!c.terminal)||(state.filter==='attention'&&c.needs_owner)));}
function statusLine() {
  q('#cp-sync-state').textContent=state.listError||state.detailError?'Data may be stale':state.lastSuccess?'Up to date':'Connecting…';
  q('#cp-last-read').textContent=state.lastSuccess?`Last refreshed ${date(state.lastSuccess)}.`:'No successful refresh yet.';
}
function showError(message) {q('#cp-error-message').textContent=message;q('#cp-error').hidden=false;statusLine();}
function renderList() {
  if(!state.data)return;
  const active=document.activeElement;
  const focusedRepo=active?.hasAttribute('data-repo')?active.dataset.repo:null;
  const focusedCampaign=active?.dataset.campaign??null;
  if(state.repo&&!state.data.projected_repositories.some(r=>r.key===state.repo))state.repo='';
  const groups=[{key:'',name:'All repositories',count:state.data.campaigns.length},...state.data.projected_repositories];
  const nav=q('#cp-repositories'),select=q('#cp-repo-select');nav.replaceChildren();select.replaceChildren();
  for(const repo of groups) {
    const name=repo.key?groupName(repo):repo.name;
    const button=node('button','cp-repo-button');button.type='button';button.dataset.repo=repo.key;button.setAttribute('aria-pressed',String(state.repo===repo.key));button.title=repo.root??(repo.key?'Scope paths outside the project index':'All recorded campaigns');
    const copy=node('span','cp-repo-copy');copy.append(node('span','',name));
    if(repo.root)copy.append(node('span','cp-repo-path',repo.root));
    button.append(copy,node('span','cp-repo-count',repo.count));nav.append(button);
    const option=node('option','',repo.root?`${name} — ${repo.root}`:name);option.value=repo.key;select.append(option);
  }
  select.value=state.repo;
  q('#cp-heading').textContent=state.repo?groupName(state.data.projected_repositories.find(r=>r.key===state.repo)):'All campaigns';
  root.querySelectorAll('[data-filter]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.filter===state.filter)));
  const campaigns=matched();
  if(!campaigns.some(c=>c.campaign_id===state.selected))state.selected=campaigns[0]?.campaign_id??null;
  q('#cp-result-count').textContent=`${campaigns.length} campaign${campaigns.length===1?'':'s'}`;
  const rows=q('#cp-rows');rows.replaceChildren();
  for(const campaign of campaigns) {
    const tr=node('tr',state.selected===campaign.campaign_id?'cp-selected':'');
    const nameCell=node('td');const button=node('button','cp-campaign-button');button.type='button';button.dataset.campaign=campaign.campaign_id;button.title=campaign.objective;button.setAttribute('aria-pressed',String(state.selected===campaign.campaign_id));
    button.append(node('span','cp-campaign-name',campaign.campaign_id),node('span','cp-phase',phaseText(campaign.phase)));nameCell.append(button);
    const repos=node('td');for(const repo of campaign.projected_repositories) {const label=node('span','cp-repo-name',groupName(repo));label.title=repo.root??'See scope paths in campaign details';repos.append(label);}
    const status=node('td');status.append(badge(campaign.lifecycle));
    const updated=node('td');const time=node('time','cp-time',age(campaign.updated_at));time.dateTime=campaign.updated_at;time.title=date(campaign.updated_at);updated.append(time);
    tr.append(nameCell,repos,status,updated);rows.append(tr);
  }
  q('#cp-loading').hidden=true;q('#cp-table').hidden=!campaigns.length;
  q('#cp-empty').hidden=campaigns.length>0;
  q('#cp-empty').textContent=state.data.campaigns.length===0?'No campaigns have been recorded yet.':'No campaigns match this repository and status filter.';
  if(!state.selected){detailGeneration++;state.detail=null;state.detailError=false;q('#cp-detail').hidden=true;if(!state.listError)q('#cp-error').hidden=true;statusLine();}
  if(focusedRepo!==null)[...root.querySelectorAll('[data-repo]')].find(button=>button.dataset.repo===focusedRepo)?.focus({preventScroll:true});
  if(focusedCampaign!==null)[...root.querySelectorAll('[data-campaign]')].find(button=>button.dataset.campaign===focusedCampaign)?.focus({preventScroll:true});
}
function addList(parent,title,items,label) {
  if(!items.length)return;
  const section=node('details','cp-record-list');section.append(node('summary','',`${title} · ${items.length}`));
  const list=node('ul');for(const item of items)list.append(node('li','',label(item)));section.append(list);parent.append(section);
}
function renderDetail(data) {
  const detail=q('#cp-detail');detail.replaceChildren();detail.hidden=false;
  const header=node('div','cp-detail-head');const title=node('div');title.append(node('div','cp-eyebrow','Selected campaign'),node('h2','',data.campaign_id));
  const id=node('div','cp-detail-id',data.campaign_id);id.id='cp-detail-id';title.append(id);header.append(title,badge(data.lifecycle));detail.append(header);
  detail.append(node('p','cp-meta-label',`Lead: ${data.accountable_primary} · Last update: ${date(data.updated_at)} · Version ${data.version}`));
  const grid=node('div','cp-detail-grid'),left=node('div'),right=node('div');
  left.append(node('h3','','Objective'),node('p','cp-description',data.objective));
  const phase=data.phase;const next=node('div','cp-next');next.append(node('h3','',data.terminal?'Recorded next gate (historical)':'Recorded next gate'),node('p','cp-description',typeof phase==='object'&&phase?.next_gate?phase.next_gate:'No next gate recorded.'));
  left.append(next);
  if(typeof phase==='object'&&phase?.checkpoint)left.append(node('h3','cp-checkpoint-label','Last checkpoint'),node('p','cp-description',phase.checkpoint));
  right.append(node('h3','','Work packages'));
  if(data.packages.total) {
    right.append(node('p','cp-description',`${data.packages.accepted} of ${data.packages.total} accepted`));
    const progress=node('progress','cp-native-progress');progress.max=data.packages.total;progress.value=data.packages.accepted;progress.setAttribute('aria-label','Accepted work packages');right.append(progress);
    if(data.packages.cancelled||data.packages.superseded)right.append(node('p','cp-fine',`${data.packages.cancelled} cancelled · ${data.packages.superseded} superseded`));
  } else right.append(node('p','cp-fine','No work packages recorded.'));
  const paths=node('div','cp-paths');paths.append(node('h3','','Scope paths'));for(const path of data.scope_roots)paths.append(node('div','cp-path',path));right.append(paths);grid.append(left,right);detail.append(grid);
  addList(detail,'Work packages',data.work_packages,p=>`${p.title} — ${p.status}`);
  addList(detail,'Pending decisions',data.decisions,d=>`${d.basis} (${d.owner_status})`);
  addList(detail,'Open gates',data.gates,g=>`${g.gate_class} — ${g.authority}`);
  addList(detail,'Open risks and blockers',data.risks,r=>`${r.title} — ${r.severity}; ${r.disposition}`);
  addList(detail,'Recent activity',data.recent_events,e=>`${date(e.timestamp)} · ${e.event_type.replaceAll('_',' ')} · ${e.actor} · v${e.new_version}`);
}
async function get(path) {
  const response=await fetch(path,{cache:'no-store',headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error(String(response.status));return response.json();
}
async function loadDetail() {
  const id=state.selected;if(!id)return;
  const generation=++detailGeneration;
  if(state.detail?.campaign_id!==id){q('#cp-detail').replaceChildren(node('p','cp-fine','Loading campaign…'));q('#cp-detail').hidden=false;state.detail=null;}
  try {
    const detail=await get('/api/campaigns/'+encodeURIComponent(id));
    if(generation!==detailGeneration||state.selected!==id)return;
    state.detail=detail;state.detailError=false;renderDetail(detail);
    if(!state.listError)q('#cp-error').hidden=true;statusLine();
  } catch(error) {
    if(generation!==detailGeneration||state.selected!==id)return;
    state.detailError=true;
    if(!state.detail)q('#cp-detail').replaceChildren(node('p','cp-fine','Campaign details are unavailable.'));
    showError(error.message==='404'?'This campaign is no longer available. Refresh the campaign list.':'Could not refresh campaign details. Previously loaded information may be stale.');
  }
}
async function refresh() {
  const generation=++listGeneration;q('#cp-refresh').disabled=true;
  try {
    const data=await get('/api/campaigns');if(generation!==listGeneration)return;
    state.data=projectCampaigns(data);state.lastSuccess=data.read_at;state.listError=false;
    q('#cp-error').hidden=true;renderList();statusLine();await loadDetail();
  } catch {
    if(generation!==listGeneration)return;
    state.listError=true;q('#cp-loading').hidden=true;
    showError(state.data?'Refresh failed. Previously loaded campaign data may be stale.':'Campaign data is unavailable. Retry once; if it persists, check the configured campaign store.');
  } finally {if(generation===listGeneration)q('#cp-refresh').disabled=false;}
}
root.addEventListener('click',event=>{
  const repo=event.target.closest('[data-repo]'),filter=event.target.closest('[data-filter]'),campaign=event.target.closest('[data-campaign]');
  if(repo)state.repo=repo.dataset.repo;else if(filter)state.filter=filter.dataset.filter;else if(campaign)state.selected=campaign.dataset.campaign;else return;
  renderList();loadDetail();
});
q('#cp-repo-select').addEventListener('change',event=>{state.repo=event.target.value;renderList();loadDetail();});
q('#cp-refresh').addEventListener('click',refresh);q('#cp-retry').addEventListener('click',refresh);
setInterval(()=>{if(!document.hidden&&!q('#cp-refresh').disabled)refresh();},30000);
refresh();

}
