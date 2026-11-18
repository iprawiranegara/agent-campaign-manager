import { DatabaseSync } from 'node:sqlite';
import { statSync, existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

const SCHEMA_VERSION = 1;
const SCHEMA_CHECKSUM = 'omo-research-campaign-schema-v1-fix1';
const TERMINAL = new Set(['CLOSED', 'CLOSED_QUALIFIED', 'ABORTED']);
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;

export class ReadError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function json(value) {
  try { return JSON.parse(value); }
  catch { throw new ReadError('STATE_INTEGRITY_ERROR'); }
}

function pathFlavor(value) {
  if (typeof value !== 'string') return null;
  if (WINDOWS_ABSOLUTE.test(value)) return 'windows';
  if (value.startsWith('/')) return 'posix';
  return null;
}

function attributionKey(path, flavor) {
  return flavor === 'windows' ? path.toLowerCase() : path;
}

/** Attribution is presentation only. Stored scopes are never repaired or rewritten. */
export function resolveScope(path) {
  if (typeof path !== 'string') return { key:String(path), name:String(path), root:String(path), kind:'scope' };
  const flavor = pathFlavor(path);
  if (!flavor) return { key:path, name:path, root:path, kind:'scope' };
  const paths = flavor === 'windows' ? win32 : posix;
  const normalized = paths.normalize(path);
  const hostCanInspect = (process.platform === 'win32' && flavor === 'windows') || (process.platform !== 'win32' && flavor === 'posix');
  if (!hostCanInspect) {
    return { key:attributionKey(normalized, flavor), name:paths.basename(normalized)||normalized, root:normalized, kind:'scope' };
  }
  const original = paths.resolve(normalized);
  try {
    const info = statSync(original);
    let current = info.isDirectory() ? original : paths.dirname(original);
    while (true) {
      if (existsSync(paths.join(current, '.git'))) {
        return { key:attributionKey(current, flavor), name:paths.basename(current)||current, root:current, kind:'repository' };
      }
      const parent = paths.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return { key:attributionKey(original, flavor), name:paths.basename(original)||original, root:original, kind:'scope' };
  } catch {
    return { key:attributionKey(original, flavor), name:paths.basename(original)||original, root:original, kind:'missing' };
  }
}

function validateOpening(db, campaign, roots) {
  const opening=db.prepare('SELECT * FROM event WHERE campaign_id=? ORDER BY new_version LIMIT 1').get(campaign.campaign_id);
  const history=db.prepare('SELECT COUNT(*) AS count, MAX(new_version) AS version FROM event WHERE campaign_id=?').get(campaign.campaign_id);
  if (!opening || opening.event_type!=='campaign_open' || opening.previous_version!==0 || opening.new_version!==1 || history.version!==campaign.version || history.count!==campaign.version) throw new ReadError('STATE_INTEGRITY_ERROR');
  const payload=json(opening.payload_json);
  if (payload.objective!==campaign.objective || payload.accountable_primary!==campaign.accountable_primary || !Array.isArray(payload.scope_roots) || JSON.stringify([...payload.scope_roots].sort())!==JSON.stringify([...roots].sort())) throw new ReadError('STATE_INTEGRITY_ERROR');
}

export function createReader({ dbPath }) {
  const flavor = pathFlavor(dbPath);
  if (typeof dbPath !== 'string' || !flavor) throw new ReadError('STORE_UNAVAILABLE');
  const path = (flavor === 'windows' ? win32 : posix).resolve(dbPath);
  const hostCanInspect = (process.platform === 'win32' && flavor === 'windows') || (process.platform !== 'win32' && flavor === 'posix');
  if (!hostCanInspect) throw new ReadError('STORE_UNAVAILABLE');

  function snapshot(callback) {
    let db;
    try {
      if (!statSync(path).isFile()) throw new ReadError('STORE_UNAVAILABLE');
      db=new DatabaseSync(path,{ readOnly:true, allowExtension:false });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=500; BEGIN');
      const migration=db.prepare('SELECT version,checksum FROM schema_migration ORDER BY version DESC LIMIT 1').get();
      if (migration?.version!==SCHEMA_VERSION || migration?.checksum!==SCHEMA_CHECKSUM) throw new ReadError('SCHEMA_UNSUPPORTED');
      const value=callback(db);
      db.exec('COMMIT');
      return value;
    } catch(error) {
      if (error instanceof ReadError) throw error;
      throw new ReadError('STORE_UNAVAILABLE');
    } finally { db?.close(); }
  }

  function summary(db,row) {
    const scope_roots=db.prepare('SELECT path FROM scope_root WHERE campaign_id=? ORDER BY path').all(row.campaign_id).map(r=>r.path);
    validateOpening(db,row,scope_roots);
    const charter=json(row.charter_json);
    const phase=charter?.current_phase??charter?.phase??null;
    const repositories=[...new Map(scope_roots.map(scope=>{const repo=resolveScope(scope);return [repo.key,repo];})).values()];
    const packages={total:0,accepted:0,cancelled:0,superseded:0};
    for(const group of db.prepare('SELECT status,COUNT(*) AS count FROM work_package WHERE campaign_id=? GROUP BY status').all(row.campaign_id)) {
      packages.total+=group.count;
      if(group.status==='ACCEPTED') packages.accepted=group.count;
      if(group.status==='CANCELLED') packages.cancelled=group.count;
      if(group.status==='SUPERSEDED') packages.superseded=group.count;
    }
    const proposed=db.prepare("SELECT COUNT(*) AS count FROM decision WHERE campaign_id=? AND status='PROPOSED'").get(row.campaign_id).count;
    return {
      campaign_id:row.campaign_id, objective:row.objective, lifecycle:row.lifecycle,
      accountable_primary:row.accountable_primary, version:row.version,
      created_at:row.created_at, updated_at:row.updated_at, phase,
      scope_roots,repositories,packages,
      terminal:TERMINAL.has(row.lifecycle),
      needs_owner:!TERMINAL.has(row.lifecycle)&&(row.lifecycle==='WAITING_OWNER'||proposed>0),
      agent_activity:'unknown',
    };
  }

  return {
    list() {
      return snapshot(db=>{
        const campaigns=db.prepare('SELECT * FROM campaign ORDER BY updated_at DESC,campaign_id ASC').all().map(row=>summary(db,row));
        const groups=new Map();
        for(const campaign of campaigns) for(const repo of campaign.repositories) {
          if(!groups.has(repo.key)) groups.set(repo.key,{...repo,count:0});
          groups.get(repo.key).count++;
        }
        return { campaigns,repositories:[...groups.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.root.localeCompare(b.root)),read_at:new Date().toISOString(),read_only:true };
      });
    },
    detail(id) {
      if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new ReadError('INVALID_ID');
      return snapshot(db=>{
        const row=db.prepare('SELECT * FROM campaign WHERE campaign_id=?').get(id);
        if(!row) return null;
        const campaign=summary(db,row);
        const work_packages=db.prepare('SELECT package_id,status,objective,contract_json,updated_at FROM work_package WHERE campaign_id=? ORDER BY created_at,package_id').all(id).map(p=>({package_id:p.package_id,status:p.status,objective:p.objective,title:json(p.contract_json)?.title??p.objective,updated_at:p.updated_at}));
        return {...campaign,work_packages,
          gates:db.prepare("SELECT gate_id,gate_class,status,authority FROM gate WHERE campaign_id=? AND status='OPEN' ORDER BY gate_id").all(id),
          decisions:db.prepare("SELECT decision_id,basis,owner_status FROM decision WHERE campaign_id=? AND status='PROPOSED' ORDER BY decision_id").all(id),
          risks:db.prepare("SELECT risk_issue_id,title,severity,status,disposition FROM risk_issue WHERE campaign_id=? AND status IN ('OPEN','MITIGATING') ORDER BY risk_issue_id").all(id),
          recent_events:db.prepare('SELECT event_type,actor,timestamp,new_version FROM event WHERE campaign_id=? ORDER BY new_version DESC LIMIT 12').all(id),
          read_at:new Date().toISOString(),
        };
      });
    },
    close() {},
  };
}
