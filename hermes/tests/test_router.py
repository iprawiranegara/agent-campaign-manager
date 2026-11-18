"""Real unchanged campaign server behind authenticated router, disposable DB only."""
import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / 'plugin'
NODE = os.environ.get('CAMPAIGN_NODE', 'node')
from test_security import private_test_root

def write_private_key(path,key):
    descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    os.close(descriptor)
    if os.name=='nt':
        spec=importlib.util.spec_from_file_location('router_bridge_security_fixture',ROOT/'bridge.py')
        mod=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.secure_new_key(path)
    path.write_bytes(key)
    if os.name=='posix':path.chmod(0o600)

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

class Router:
    def __init__(self, tmp_path, channels_mode=0o700):
        self.home = private_test_root(tmp_path) / 'fixture with spaces Ω'
        self.home.mkdir(mode=0o700)
        self.channels = self.home / 'channels'
        if os.name == 'nt':
            module=(ROOT/'security.mjs').as_uri()
            script=f"import {{ensurePrivateDirectory}} from {json.dumps(module)};ensurePrivateDirectory(process.argv[1]);"
            subprocess.run([NODE,'--input-type=module','-e',script,str(self.channels)],check=True,capture_output=True,text=True)
        else:
            self.channels.mkdir(mode=channels_mode)
            self.channels.chmod(channels_mode)
        self.state = self.home / 'state'
        self.state.mkdir()
        self.scope = self.home / 'scope'
        self.scope.mkdir()
        self.key = secrets.token_bytes(32)
        self.channel = secrets.token_hex(16)
        write_private_key(self.channels / (self.channel + '.key'),self.key)
        js = f"import {{createStore}} from {json.dumps((SOURCE/'packages/campaign-core/src/core.mjs').as_uri())};const s=createStore({{dbPath:{json.dumps(str(self.state/'campaigns.sqlite3'))},allowCreate:true}});s.dispose();"
        subprocess.run([NODE,'--input-type=module','-e',js],check=True,capture_output=True)
        self.proc = subprocess.Popen([NODE,str(ROOT/'router.mjs'),'--channels',str(self.channels),'--state',str(self.state),'--fixture','--fixture-root',str(self.home)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'TMPDIR':str(self.home)})
        self.serial = 0
        self.lock = threading.Lock()
    def rpc(self, method, params=None):
        with self.lock:
            self.serial += 1
            self.proc.stdin.write(canonical({'jsonrpc':'2.0','id':self.serial,'method':method,'params':params or {}})+'\n')
            self.proc.stdin.flush()
            raw = self.proc.stdout.readline()
            assert raw, self.proc.stderr.read()
            return json.loads(raw)
    def signed(self, tool, args=None, route='a', nonce=None):
        payload={'tool':tool,'arguments':args or {},'route':hashlib.sha256(route.encode()).hexdigest(),'nonce':nonce or secrets.token_hex(16),'time':int(time.time())}
        encoded=base64.b64encode(canonical(payload).encode()).decode()
        sig=hmac.new(self.key,encoded.encode(),hashlib.sha256).hexdigest()
        return {'_adapter':{'channel':self.channel,'payload':encoded,'signature':sig}}
    def call(self,tool,args=None,route='a'):
        return self.rpc('tools/call',{'name':tool,'arguments':self.signed(tool,args,route)})['result']
    def data(self,tool,args=None,route='a'):
        return self.call(tool,args,route)['structuredContent']
    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=10)
        assert self.proc.returncode == 0, self.proc.stderr.read()

def test_authenticated_router_separates_bindings(tmp_path):
    r=Router(tmp_path)
    try:
        init=r.rpc('initialize',{'protocolVersion':'2025-06-18'})
        assert init['result']['serverInfo']['name']=='hermes-campaign-router'
        listed=r.rpc('tools/list')['result']['tools']
        hints={t['name']:t.get('annotations',{}).get('readOnlyHint',False) for t in listed}
        assert hints['campaign_status'] is True
        assert hints['campaign_create'] is False
        assert r.data('campaign_list')['campaigns']==[]
        made=r.data('campaign_create',{'campaign_id':'alpha','objective':'Synthetic α','scope_roots':[str(r.scope)],'actor':'owner'})
        assert made['version']==1
        detail=r.data('campaign_detail',{'campaign_id':'alpha'})
        bind={'campaign_id':'alpha','expected_version':1,'identity_digest':detail['identity_digest'],'actor':'owner','run_id':'test','thread_id':'a','client':'hermes'}
        assert r.data('campaign_bind',bind)['mode']=='BOUND_ACTIVE'
        assert r.data('campaign_status')['campaign_id']=='alpha'
        assert r.data('campaign_status',route='b')['code']=='CAMPAIGN_NOT_BOUND'
        r.call('campaign_unbind',route='b')
        assert r.data('campaign_status')['campaign_id']=='alpha'
        r.call('campaign_unbind')
        assert r.data('campaign_status')['code']=='CAMPAIGN_NOT_BOUND'
    finally:r.close()

def test_forgery_replay_and_cross_tool_use_are_rejected(tmp_path):
    r=Router(tmp_path)
    try:
        first=r.signed('campaign_list')
        assert r.rpc('tools/call',{'name':'campaign_list','arguments':first})['result']['structuredContent']['campaigns']==[]
        assert r.rpc('tools/call',{'name':'campaign_list','arguments':first})['result']['structuredContent']['code']=='ADAPTER_AUTH_REJECTED'
        forged=r.signed('campaign_create')
        forged['_adapter']['signature']='0'*64
        assert r.rpc('tools/call',{'name':'campaign_create','arguments':forged})['result']['structuredContent']['code']=='ADAPTER_AUTH_REJECTED'
        wrong_tool=r.signed('campaign_list')
        assert r.rpc('tools/call',{'name':'campaign_create','arguments':wrong_tool})['result']['structuredContent']['code']=='ADAPTER_AUTH_REJECTED'
        assert r.data('campaign_list')['campaigns']==[]
    finally:r.close()

def test_lost_binding_token_blocks_operation_after_router_restart(tmp_path):
    r=Router(tmp_path)
    try:
        request=r.signed('campaign_create',{'campaign_id':'must-not-exist','objective':'Synthetic','scope_roots':[str(r.scope)],'actor':'owner'})
        payload=json.loads(base64.b64decode(request['_adapter']['payload']))
        payload['expected_binding']='old-process-binding'
        encoded=base64.b64encode(canonical(payload).encode()).decode()
        request['_adapter'].update(payload=encoded,signature=hmac.new(r.key,encoded.encode(),hashlib.sha256).hexdigest())
        result=r.rpc('tools/call',{'name':'campaign_create','arguments':request})['result']['structuredContent']
        assert result['code']=='ADAPTER_BINDING_LOST'
        assert r.data('campaign_list')['campaigns']==[]
    finally:r.close()

def test_shared_state_version_checks_and_profile_channel_isolation(tmp_path):
    r=Router(tmp_path)
    try:
        made=r.data('campaign_create',{'campaign_id':'shared','objective':'Shared synthetic','scope_roots':[str(r.scope)],'actor':'owner'})
        bind={'campaign_id':'shared','expected_version':1,'identity_digest':made['identity_digest'],'actor':'owner','run_id':'run-a','thread_id':'chat-a'}
        first=r.data('campaign_bind',bind)
        assert first.get('mode')=='BOUND_ACTIVE',first
        second=r.data('campaign_bind',{**bind,'run_id':'run-b','thread_id':'chat-b'},route='b')
        assert second.get('mode')=='BOUND_ACTIVE',second
        changed=r.data('campaign_update',{'expected_version':1,'actor':'owner','lifecycle':'ORIENTING'})
        assert changed.get('version')==2,changed
        assert r.data('campaign_status',route='b')['version']==2
        rejected=r.data('campaign_update',{'expected_version':1,'actor':'owner','lifecycle':'ORIENTING'},route='b')
        assert rejected['code']=='CAMPAIGN_VERSION_CONFLICT'
        assert rejected['details']['mutated'] is False
        r.channel=secrets.token_hex(16);r.key=secrets.token_bytes(32)
        path=r.channels/(r.channel+'.key');write_private_key(path,r.key)
        assert r.data('campaign_status')['code']=='CAMPAIGN_NOT_BOUND'
    finally:r.close()

def test_fixture_requires_explicit_containment_root(tmp_path):
    r=Router(tmp_path)
    try:
        command=[NODE,str(ROOT/'router.mjs'),'--channels',str(r.channels),'--state',str(r.state),'--fixture']
        missing=subprocess.run(command,input='',capture_output=True,text=True)
        assert missing.returncode!=0
        outside=subprocess.run(command+['--fixture-root',str(r.channels)],input='',capture_output=True,text=True)
        assert outside.returncode!=0
    finally:r.close()

def test_router_rejects_insecure_channel_directory_at_startup(tmp_path):
    import pytest
    if os.name != 'posix':pytest.skip('Use the Windows DACL regression on Windows')
    r=Router(tmp_path,channels_mode=0o777)
    try:
        code=r.proc.poll()
        if code is None:
            r.proc.stdin.close()
            r.proc.wait(timeout=10)
            code=r.proc.returncode
        assert code is not None and code != 0, 'router must fail closed for a group/world-accessible channel directory'
    finally:
        if r.proc.poll() is None:
            r.proc.kill()
            r.proc.wait(timeout=10)

def test_router_rejects_untrusted_windows_channel_dacl(tmp_path):
    import pytest
    if os.name != 'nt':pytest.skip('Windows DACL check requires native Windows')
    r=Router(tmp_path)
    r.close()
    grant=subprocess.run(['icacls',str(r.channels),'/grant','*S-1-1-0:(OI)(CI)F'],capture_output=True,text=True,timeout=10)
    assert grant.returncode==0,grant.stdout+grant.stderr
    command=[NODE,str(ROOT/'router.mjs'),'--channels',str(r.channels),'--state',str(r.state),'--fixture','--fixture-root',str(r.home)]
    denied=subprocess.run(command,input='',capture_output=True,text=True,timeout=10)
    assert denied.returncode!=0, 'router startup must fail closed when the channel DACL grants Everyone access'

def test_windows_security_rejects_directory_junction(tmp_path):
    import pytest
    if os.name != 'nt':pytest.skip('Windows reparse-point check requires native Windows')
    spec=importlib.util.spec_from_file_location('windows_bridge_security_test',ROOT/'bridge.py')
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    root=private_test_root(tmp_path)
    target=mod.ensure_private_directory(root/'target')
    junction=root/'junction'
    command=f'mklink /J "{junction}" "{target}"'
    linked=subprocess.run(command,shell=True,executable=os.environ.get('COMSPEC','cmd.exe'),capture_output=True,text=True,timeout=10)
    assert linked.returncode==0,linked.stdout+linked.stderr
    with pytest.raises(ValueError,match='security check failed'):
        mod.verify_private_path(junction,'directory')

def test_fixture_rejects_windows_separator_escape(tmp_path):
    if os.name != 'nt':
        import pytest
        pytest.skip('Windows path separator behavior requires native Windows')
    r=Router(tmp_path)
    try:
        outside=r.home.parent/(r.home.name+'-outside')
        outside.mkdir()
        command=[NODE,str(ROOT/'router.mjs'),'--channels',str(r.channels),'--state',str(outside),'--fixture','--fixture-root',str(r.home)]
        result=subprocess.run(command,input='',capture_output=True,text=True,timeout=10)
        assert result.returncode != 0, 'a Windows backslash traversal must not pass fixture containment'
    finally:r.close()

def test_router_keeps_hermes_contract_when_codex_hook_mode_is_inherited(tmp_path,monkeypatch):
    monkeypatch.setenv('CODEX_CAMPAIGN_CONTEXT_HOOKS','1')
    r=Router(tmp_path)
    try:
        assert r.data('campaign_list')['campaigns']==[]
    finally:r.close()
