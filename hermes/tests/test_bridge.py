import importlib.util
import json
import os
from pathlib import Path
import secrets
import pytest

ROOT=Path(__file__).resolve().parents[1]

def module():
    spec=importlib.util.spec_from_file_location('campaign_bridge_under_test',ROOT/'bridge.py')
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

class Context:
    def __init__(self): self.calls=[]
    def call_mcp(self, server, tool, arguments, timeout=30):
        self.calls.append((server,tool,arguments))
        return {'ok':True,'structuredContent':{'mode':'BOUND_ACTIVE','campaign_id':'alpha','version':1,'binding_token':'bound'}}

def channel_dir(tmp_path,mod):
    if os.name=='nt':
        base=Path(os.environ['LOCALAPPDATA'])/'campaign-manager-private-path-tests'
        mod.ensure_private_directory(base)
        root=mod.ensure_private_directory(base/(tmp_path.name+'-'+secrets.token_hex(6)))
    else:
        root=tmp_path.resolve()
    return mod.ensure_private_directory(root/'channels')

def test_bridge_rejects_model_routing_and_missing_identity(tmp_path):
    mod=module(); ctx=Context(); directory=channel_dir(tmp_path,mod); b=mod.Bridge(ctx,directory,'profile-a')
    assert b.call('campaign_list',{},session_id=None)['code']=='ADAPTER_IDENTITY_REQUIRED'
    assert b.call('campaign_list',{'_adapter':{}},session_id='a')['code']=='ADAPTER_ROUTING_ARGUMENT'
    assert b.call('campaign_list',{'session_id':'b'},session_id='a')['code']=='ADAPTER_ROUTING_ARGUMENT'
    assert ctx.calls==[]
    b.close()

def test_bridge_signs_host_route_and_adapts_bind_metadata(tmp_path):
    import base64, hashlib, hmac
    mod=module();ctx=Context();directory=channel_dir(tmp_path,mod);b=mod.Bridge(ctx,directory,'profile-a')
    result=b.call('campaign_bind',{'campaign_id':'alpha','thread_id':'FORGED','client':'codex'},session_id='real-a')
    assert result['campaign_id']=='alpha'
    server,tool,args=ctx.calls[0]
    auth=args['_adapter']
    data=json.loads(base64.b64decode(auth['payload']))
    assert args['arguments']==data['arguments'], 'Native approval must show the actual arguments in plain JSON'
    assert data['arguments']['thread_id']=='real-a'
    assert data['arguments']['client']=='hermes'
    assert len(data['route'])==64
    assert data['route']!=b.route('real-b')
    key=(directory/(auth['channel']+'.key')).read_bytes()
    assert hmac.compare_digest(auth['signature'],hmac.new(key,auth['payload'].encode(),hashlib.sha256).hexdigest())
    key_path=directory/(auth['channel']+'.key')
    assert mod.verify_private_path(key_path,'key')
    if os.name=='posix':assert key_path.stat().st_mode & 0o777 == 0o600
    b.close()
    assert not list(directory.glob('*.key'))

def test_unknown_outcome_never_retried(tmp_path):
    mod=module();ctx=Context()
    def fail(*a,**kw):ctx.calls.append(a);raise TimeoutError('not exposed')
    ctx.call_mcp=fail;directory=channel_dir(tmp_path,mod);b=mod.Bridge(ctx,directory,'p')
    result=b.call('campaign_update',{},session_id='a')
    assert result['details']['mutated'] is None
    assert len(ctx.calls)==1
    b.close()

def test_bridge_rejects_insecure_existing_channel_directory(tmp_path):
    if os.name != 'posix':pytest.skip('POSIX mode check is exercised only on POSIX')
    if os.name=='nt':pytest.skip('Untrusted Windows DACL rejection is exercised by router security test')
    directory=tmp_path.resolve()/'channels'
    directory.mkdir(mode=0o777)
    directory.chmod(0o777)
    mod=module()
    with pytest.raises(ValueError,match='secure|permission|channel|writable|owner'):
        mod.Bridge(Context(),directory,'profile-a')
    assert directory.stat().st_mode & 0o777 == 0o777
    assert not list(directory.glob('*.key'))
