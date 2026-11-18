import { createServer as httpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createReader, ReadError } from './read-store.mjs';
import { validateProjects } from './project-catalog.mjs';

const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
const projectCatalogPath=fileURLToPath(new URL('./project-catalog.mjs',import.meta.url));
const staticFiles=new Map([
  ['/',['index.html','text/html; charset=utf-8']],
  ['/dashboard.css',['dashboard.css','text/css; charset=utf-8']],
  ['/dashboard.js',['dashboard.js','text/javascript; charset=utf-8']],
  ['/project-catalog.js',[projectCatalogPath,'text/javascript; charset=utf-8']],
]);
const DEFAULT_ALLOWED_HOSTS=['127.0.0.1','localhost'];
const headers={
  'Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
};

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/\.$/,'');
}

function validateAllowedHosts(allowedHosts) {
  if(!Array.isArray(allowedHosts)) throw new TypeError('allowedHosts must be an array of host names.');
  const result=[];
  for(const value of allowedHosts) {
    if(typeof value!=='string'||!value||value.trim()!==value||/[\s/@?#]/.test(value)) throw new TypeError('Each allowedHosts entry must be a host name without a scheme, port, path, or whitespace.');
    let parsed;
    try {parsed=new URL(`http://${value}`);} catch {throw new TypeError(`Invalid allowedHosts entry: ${value}`);}
    if(parsed.username||parsed.password||parsed.port||parsed.pathname!=='/'||parsed.search||parsed.hash) throw new TypeError(`Invalid allowedHosts entry: ${value}`);
    const hostname=normalizeHostname(parsed.hostname);
    if(!hostname) throw new TypeError(`Invalid allowedHosts entry: ${value}`);
    if(!result.includes(hostname)) result.push(hostname);
  }
  return result;
}

function hostHeader(value) {
  if(typeof value!=='string'||!value||/[\s/@?#]/.test(value)) return null;
  try {
    const parsed=new URL(`http://${value}`);
    if(parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash) return null;
    return {hostname:normalizeHostname(parsed.hostname),host:parsed.host.toLowerCase()};
  } catch { return null; }
}

function sameOrigin(origin,requestHost) {
  if(!origin) return true;
  try {
    const parsed=new URL(origin);
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash) return false;
    return parsed.host.toLowerCase()===requestHost.host;
  } catch { return false; }
}

export function createServer({reader,projects=[],allowedHosts=DEFAULT_ALLOWED_HOSTS}={}) {
  if(!reader||typeof reader.list!=='function'||typeof reader.detail!=='function') throw new TypeError('A read-only campaign reader is required.');
  const projectCatalog=validateProjects(projects);
  const hosts=validateAllowedHosts(allowedHosts);
  const server=httpServer((req,res)=>{
    function send(status,body,type='application/json; charset=utf-8',extra={}) {
      res.writeHead(status,{...headers,'Content-Type':type,...extra});
      res.end(req.method==='HEAD'?undefined:Buffer.isBuffer(body)?body:typeof body==='object'?JSON.stringify(body):body);
    }
    try {
      const requestHost=hostHeader(req.headers.host);
      if(!requestHost||!hosts.includes(requestHost.hostname)) return send(403,{error:'ACCESS_DENIED',message:'This host is not allowed.'});
      if(req.headers['sec-fetch-site']==='cross-site'||!sameOrigin(req.headers.origin,requestHost)) return send(403,{error:'ACCESS_DENIED',message:'Use the dashboard address directly.'});
      if(!['GET','HEAD'].includes(req.method)) return send(405,{error:'READ_ONLY',message:'This dashboard supports reading only.'},undefined,{Allow:'GET, HEAD'});
      const path=new URL(req.url,`http://${requestHost.host}`).pathname;
      if(staticFiles.has(path)) {
        const [file,type]=staticFiles.get(path);
        const pathOnDisk=['index.html','dashboard.css','dashboard.js'].includes(file)?join(publicRoot,file):file;
        return send(200,readFileSync(pathOnDisk),type);
      }
      if(path==='/api/campaigns') return send(200,{...reader.list(),project_catalog:projectCatalog});
      if(path==='/health') {reader.list();return send(200,{status:'ok',read_only:true});}
      if(path.startsWith('/api/campaigns/')) {
        let id;
        try {id=decodeURIComponent(path.slice('/api/campaigns/'.length));}
        catch {return send(400,{error:'INVALID_ID',message:'Invalid campaign ID.'});}
        const detail=reader.detail(id);
        return detail?send(200,detail):send(404,{error:'NOT_FOUND',message:'Campaign not found. Refresh the campaign list.'});
      }
      return send(404,{error:'NOT_FOUND',message:'Page not found.'});
    } catch(error) {
      if(error instanceof ReadError&&error.code==='INVALID_ID') return send(400,{error:'INVALID_ID',message:'Invalid campaign ID.'});
      return send(503,{error:error instanceof ReadError?error.code:'STORE_UNAVAILABLE',message:'Campaign data is unavailable. Retry once; if it persists, check the configured store and its schema.'});
    }
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  return server;
}

function startupStoreError(dbPath,error) {
  const location=typeof dbPath==='string'?` at "${dbPath}"`:'';
  if(error instanceof ReadError&&error.code==='SCHEMA_UNSUPPORTED') {
    return new Error(`Campaign dashboard cannot read the existing database${location}: its schema is unsupported. Use a dashboard release that matches this campaign store. The dashboard did not migrate or change the file.`,{cause:error});
  }
  if(error instanceof ReadError&&error.code==='STATE_INTEGRITY_ERROR') {
    return new Error(`Campaign dashboard cannot read the existing database${location}: campaign state failed its integrity checks. Check the store with the campaign manager before starting the dashboard. The dashboard did not repair or change it.`,{cause:error});
  }
  return new Error(`Campaign dashboard cannot read the existing database${location}. Verify that the file exists and is readable by this user. The dashboard does not create, migrate, or change the store.`,{cause:error});
}

export async function startDashboard({dbPath,port=52526,projects=[],allowedHosts=DEFAULT_ALLOWED_HOSTS}={}) {
  if(!Number.isInteger(port)||port<0||port>65535) throw new TypeError('Dashboard port must be an integer from 0 to 65535.');
  let reader;
  let server;
  try {
    reader=createReader({dbPath});
    server=createServer({reader,projects,allowedHosts});
    reader.list();
  } catch(error) {
    reader?.close();
    if(error instanceof ReadError) throw startupStoreError(dbPath,error);
    throw error;
  }

  try {
    await new Promise((resolve,reject)=>{
      const onError=error=>{server.off('listening',onListening);reject(error);};
      const onListening=()=>{server.off('error',onError);resolve();};
      server.once('error',onError);
      server.once('listening',onListening);
      server.listen(port,'127.0.0.1');
    });
  } catch(error) {
    reader.close();
    throw new Error(`Could not bind the campaign dashboard to 127.0.0.1:${port}. Choose a free local port and try again${error.code?` (${error.code})`:''}.`,{cause:error});
  }

  let closePromise;
  const close=()=>{
    if(!closePromise) closePromise=new Promise((resolve,reject)=>server.close(error=>{
      reader.close();
      if(error) reject(error); else resolve();
    }));
    return closePromise;
  };
  return {server,address:server.address(),reader,close};
}
