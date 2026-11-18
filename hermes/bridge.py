"""Authenticated conversation routes through the public native MCP facade only."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import ntpath
import re
import secrets
import stat
import subprocess
import sys
import threading
import time

SERVER = 'campaign-router'
RESERVED = {'session_id', '_adapter', '_hermes_session', 'route', 'signature', 'channel'}
WINDOWS_SECURITY = Path(__file__).with_name('windows-security.ps1')

def error(code, message, mutated=False):
    return {'code':code,'message':message,'details':{'mutated':mutated,'next_action':'Inspect current campaign state before any retry; explicitly rebind after connection loss.'}}

def _run_windows_security(operation, path):
    system_root=os.environ.get('SystemRoot') or os.environ.get('WINDIR') or r'C:\Windows'
    powershell=Path(system_root)/'System32'/'WindowsPowerShell'/'v1.0'/'powershell.exe'
    if not powershell.is_file():powershell=Path('powershell.exe')
    # Windows PowerShell 5.1 must build its own module path; a PowerShell 7 parent's PSModulePath breaks Get-Acl.
    kwargs={'capture_output':True,'check':False,'env':{k:v for k,v in os.environ.items() if k.lower()!='psmodulepath'}}
    if sys.platform=='win32':kwargs['creationflags']=getattr(subprocess,'CREATE_NO_WINDOW',0)
    try:
        result=subprocess.run([
            str(powershell),'-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
            '-File',str(WINDOWS_SECURITY),operation,os.path.abspath(os.fspath(path)),
        ],**kwargs)
    except OSError as exc:
        raise ValueError('Windows private-path security helper failed') from exc
    if result.returncode!=0:
        output=(result.stderr or b'').decode(errors='replace')+'\n'+(result.stdout or b'').decode(errors='replace')
        match=re.search(r'Windows private-path security check failed: ([^\r\n]+)',output)
        detail=f': {match.group(1)}' if match else ''
        raise ValueError('Windows private-path security check failed'+detail)

def _check_posix_ancestors(path):
    current=Path(path.anchor)
    owner=os.getuid()
    for part in path.parts[1:]:
        current=current/part
        info=os.lstat(current)
        if stat.S_ISLNK(info.st_mode):raise ValueError('Private path ancestor may not be a symlink')
        if not stat.S_ISDIR(info.st_mode):raise ValueError('Private path ancestors must be directories')
        sticky=bool(info.st_mode & stat.S_ISVTX)
        if info.st_mode & 0o022 and not sticky:raise ValueError('Private path ancestor is writable by other users')
        if info.st_uid not in (owner,0):raise ValueError('Private path ancestor has an unexpected owner')

def _posix_private_path(path,kind):
    if not hasattr(os,'getuid'):raise ValueError('POSIX ownership checks are unavailable')
    raw=os.fspath(path)
    if os.name=='nt' and not ntpath.isabs(raw):raise ValueError('Private Windows path must be absolute')
    requested=Path(os.path.abspath(raw))
    if requested == Path(requested.anchor):raise ValueError('A filesystem root cannot be a private channel path')
    try:
        requested_info=os.lstat(requested)
        if stat.S_ISLNK(requested_info.st_mode):raise ValueError('Private path may not be a symlink')
        target=Path(os.path.realpath(requested.parent))/requested.name
    except FileNotFoundError:
        raise
    _check_posix_ancestors(target.parent)
    info=os.lstat(target)
    if stat.S_ISLNK(info.st_mode):raise ValueError('Private path may not be a symlink')
    if kind=='directory' and not stat.S_ISDIR(info.st_mode):raise ValueError('Private path is not a directory')
    if kind=='key' and not stat.S_ISREG(info.st_mode):raise ValueError('Private path is not a regular file')
    if info.st_uid!=os.getuid() or info.st_mode & 0o077:raise ValueError('Private path owner or permissions rejected')
    return target

def verify_private_path(path,kind):
    if kind not in ('directory','key'):raise ValueError('Unsupported private-path kind')
    if os.name=='nt':
        _run_windows_security('verify-directory' if kind=='directory' else 'verify-key',path)
        return Path(os.path.abspath(os.fspath(path)))
    return _posix_private_path(path,kind)

def secure_new_key(path):
    if os.name=='nt':_run_windows_security('secure-key',path)
    return verify_private_path(path,'key')

def ensure_private_directory(path):
    if os.name=='nt':
        _run_windows_security('ensure-directory',path)
        return Path(os.path.abspath(os.fspath(path)))
    try:return _posix_private_path(path,'directory')
    except FileNotFoundError:pass
    requested=Path(os.path.abspath(os.fspath(path)))
    if requested == Path(requested.anchor):raise ValueError('A filesystem root cannot be a private channel directory')
    if requested.exists() or requested.is_symlink():return _posix_private_path(requested,'directory')
    existing=requested.parent
    missing=[]
    while True:
        try:
            info=os.lstat(existing)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):raise ValueError('Private path parent must be a real directory')
            target=Path(os.path.realpath(existing)).joinpath(*reversed(missing),requested.name)
            break
        except FileNotFoundError:
            parent=existing.parent
            if parent==existing:raise
            missing.append(existing.name)
            existing=parent
    _check_posix_ancestors(Path(os.path.realpath(existing)))
    current=Path(os.path.realpath(existing))
    for component in [*reversed(missing),requested.name]:
        current=current/component
        try:os.mkdir(current,0o700)
        except FileExistsError:pass
        info=os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):raise ValueError('Private path component is not a real directory')
        if info.st_uid!=os.getuid() or info.st_mode & 0o077:raise ValueError('New private directory has insecure owner or permissions')
    target=current
    return _posix_private_path(target,'directory')

def _same_file(left,right):
    return left.st_dev==right.st_dev and left.st_ino==right.st_ino and left.st_ino!=0

def unwrap(envelope):
    if envelope.get('truncated'):
        return error('ADAPTER_RESULT_TRUNCATED','Campaign result exceeded the native facade cap.',None)
    if not envelope.get('ok'):
        raw=envelope.get('error')
        if isinstance(raw,str):
            try:
                value=json.loads(raw)
                if isinstance(value,dict) and 'code' in value:return value
            except ValueError:pass
        return error('ADAPTER_NATIVE_DENIED_OR_FAILED',str(raw),None)
    value=envelope.get('structuredContent',envelope.get('result'))
    if isinstance(value,str):
        try:value=json.loads(value)
        except ValueError:return error('ADAPTER_INVALID_RESULT','Non-JSON campaign response.',None)
    if not isinstance(value,dict):return error('ADAPTER_INVALID_RESULT','Malformed campaign response.',None)
    return value

class Bridge:
    def __init__(self,ctx,channel_dir,profile):
        self.ctx=ctx
        self.profile=str(profile)
        self.directory=ensure_private_directory(channel_dir)
        self.channel=secrets.token_hex(16)
        self.key=secrets.token_bytes(32)
        self.path=self.directory/(self.channel+'.key')
        flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0)
        fd=os.open(self.path,flags,0o600)
        try:
            created=os.fstat(fd)
            if os.name=='nt':
                os.close(fd)
                fd=-1
                secure_new_key(self.path)
                fd=os.open(self.path,os.O_WRONLY|getattr(os,'O_NOFOLLOW',0))
                if not _same_file(created,os.fstat(fd)):raise ValueError('Created channel key identity changed')
            with os.fdopen(fd,'wb') as out:
                out.write(self.key)
                out.flush()
                opened=os.fstat(out.fileno())
                fd=-1
            checked=verify_private_path(self.path,'key')
            current=os.lstat(checked)
            if not _same_file(opened,current):raise ValueError('Created channel key identity changed')
            self.path=checked
        except Exception:
            if fd>=0:
                try:os.close(fd)
                except OSError:pass
            try:self.path.unlink(missing_ok=True)
            except OSError:pass
            self.key=b''
            raise
        self.lock=threading.RLock()
        self.route_locks={}
        self.sessions={}
        self.closed=False
    def session_lock(self,sid):
        with self.lock:
            return self.route_locks.setdefault(sid,threading.RLock())
    def route(self,sid):
        return hashlib.sha256(json.dumps([self.profile,sid],separators=(',',':')).encode()).hexdigest()
    def _send(self,tool,args,sid,**control):
        state=self.sessions.setdefault(sid,{'generation':0,'bound':False,'token':None,'dirty':False})
        payload={'tool':tool,'arguments':args,'route':self.route(sid),'time':int(time.time()),'nonce':secrets.token_hex(16),**control}
        if state['token'] and tool not in ('campaign_unbind',):payload['expected_binding']=state['token']
        text=json.dumps(payload,sort_keys=True,separators=(',',':'),ensure_ascii=False)
        encoded=base64.b64encode(text.encode()).decode()
        auth={'channel':self.channel,'payload':encoded,'signature':hmac.new(self.key,encoded.encode(),hashlib.sha256).hexdigest()}
        try:return unwrap(self.ctx.call_mcp(SERVER,tool,{'arguments':args,'_adapter':auth},timeout=20))
        except Exception:return error('ADAPTER_OUTCOME_UNKNOWN','Native MCP call failed. Outcome unknown; not retried.',None)
    def call(self,tool,args,*,session_id=None):
        if not isinstance(session_id,str) or not session_id.strip():return error('ADAPTER_IDENTITY_REQUIRED','Runtime conversation identity required.')
        if not isinstance(args,dict) or RESERVED.intersection(args):return error('ADAPTER_ROUTING_ARGUMENT','Model routing arguments are forbidden.')
        with self.session_lock(session_id):
            if self.closed:return error('ADAPTER_UNLOADED','Adapter unloaded; rebind explicitly.')
            args=dict(args)
            if tool=='campaign_bind':args.update(client='hermes',thread_id=session_id)
            result=self._send(tool,args,session_id)
            state=self.sessions[session_id]
            state['generation']+=1
            if tool=='campaign_unbind' or result.get('code') in ('ADAPTER_CONNECTION_LOST','ADAPTER_BINDING_LOST','ADAPTER_OUTCOME_UNKNOWN'):
                state.update(bound=False,token=None,dirty=False)
            elif tool=='campaign_bind' and result.get('mode')=='BOUND_ACTIVE':
                state.update(bound=True,token=result.get('binding_token'),dirty=False)
            return result
    def compact(self,*,session_id,old_session_id='',**kwargs):
        from contextlib import ExitStack
        with ExitStack() as stack:
            for sid in sorted({session_id,old_session_id} - {''}):stack.enter_context(self.session_lock(sid))
            if self.closed:return
            if old_session_id and old_session_id!=session_id:
                old=self.sessions.get(old_session_id)
                if not old or not old['bound'] or session_id in self.sessions:return
                result=self._send('campaign_status',{},old_session_id,control='rotate',target=self.route(session_id))
                if not result.get('rotated'):
                    old.update(bound=False,token=None,dirty=False)
                    return
                self.sessions[session_id]=self.sessions.pop(old_session_id)
            state=self.sessions.get(session_id)
            if state and state['bound']:state['dirty']=True
    def checkpoint(self,sid):
        with self.session_lock(sid):
            state=self.sessions.get(sid)
            if self.closed or not state or not state['bound'] or not state['dirty']:return None
            # Native untrusted policy remains in effect; never auto-approve reminder reads.
            result=self._send('campaign_status',{'view':'full'},sid)
            if 'code' in result:
                state['dirty']=False
                if result['code'] in ('ADAPTER_CONNECTION_LOST','ADAPTER_BINDING_LOST','ADAPTER_OUTCOME_UNKNOWN'):
                    state.update(bound=False,token=None)
                return None
            return result
    def release(self,sid):
        with self.session_lock(sid):
            if sid not in self.sessions:return
            self._send('campaign_unbind',{},sid,control='release')
            self.sessions.pop(sid,None)
    def close(self):
        with self.lock:
            self.closed=True
            identities=list(self.route_locks)
        for sid in identities:self.release(sid)
        try:
            checked=verify_private_path(self.path,'key')
            fd=os.open(checked,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
            opened=os.fstat(fd)
            current=os.lstat(checked)
            same=_same_file(opened,current)
            os.close(fd)
            fd=-1
            if same:checked.unlink(missing_ok=True)
        except (FileNotFoundError,OSError,ValueError):pass
        if 'fd' in locals() and fd>=0:
            try:os.close(fd)
            except OSError:pass
        self.key=b''
