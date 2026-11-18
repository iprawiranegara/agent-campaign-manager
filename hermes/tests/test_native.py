"""Native Hermes permission checks in an isolated process and profile."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT.parent / 'plugin'
NODE=__import__('os').environ.get('CAMPAIGN_NODE', 'node')

import pytest
pytestmark = pytest.mark.skipif(not os.environ.get('HERMES_SOURCE'), reason='Set HERMES_SOURCE to run optional native Hermes integration')

def test_native_facade_denial_and_runtime_identity(tmp_path):
    import subprocess
    code=r'''
import os,sys,json,subprocess,importlib.util
from pathlib import Path
from unittest.mock import patch
root=Path(sys.argv[1]);tmp=Path(sys.argv[2]);source=Path(sys.argv[3]);node=sys.argv[4]
home=tmp/'home';home.mkdir(mode=0o700);channels=home/'channels';state=tmp/'state';state.mkdir();scope=tmp/'scope';scope.mkdir()
os.environ['HERMES_HOME']=str(home)
sys.path.insert(0,os.environ['HERMES_SOURCE'])
(home/'config.yaml').write_text('plugins:\n  entries:\n    campaign-manager:\n      mcp_allowlist: [campaign-router]\n')
subprocess.run([node,'--input-type=module','-e',f"import {{createStore}} from {json.dumps((source/'packages/campaign-core/src/core.mjs').as_uri())};const s=createStore({{dbPath:{json.dumps(str(state/'campaigns.sqlite3'))},allowCreate:true}});s.dispose();"],check=True,capture_output=True)
from hermes_cli.plugins import PluginManager,PluginContext,PluginManifest
from tools.registry import registry,session_tool_scope
from tools.mcp_tool_discovery import register_mcp_servers
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
spec=importlib.util.spec_from_file_location('campaign_bridge',root/'bridge.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
mgr=PluginManager();mgr._discovered=True
ctx=PluginContext(PluginManifest(name='campaign-manager',source='user'),mgr)
bridge=mod.Bridge(ctx,channels,str(home))
for name in ['campaign_create','campaign_list','campaign_search','campaign_detail','campaign_bind','campaign_status','campaign_preflight','campaign_work_package','campaign_receipt','campaign_reconcile','campaign_update','campaign_finish','campaign_abandon','campaign_unbind']:
 def handler(args,session_id=None,_name=name,**kwargs):return json.dumps(bridge.call(_name,args,session_id=session_id))
 ctx.register_tool(name=name,toolset='campaign',schema={'name':name,'description':name,'parameters':{'type':'object','properties':{}}},handler=handler)
def call(name,args=None,sid='a'):
 with session_tool_scope(mgr.scope_key):return json.loads(registry.dispatch(name,args or {},session_id=sid,scope=mgr.scope_key))
try:
 with session_tool_scope(mgr.scope_key):
  names=register_mcp_servers({'campaign-router':{'command':node,'args':[str(root/'router.mjs'),'--channels',str(channels),'--state',str(state),'--fixture','--fixture-root',str(tmp)],'cwd':str(root),'tools':{'include':[]},'resources':False,'prompts':False,'trust':'untrusted','lazy':False,'connect_timeout':15}})
 assert not [n for n in names if 'mcp__campaign_router' in n]
 args={'campaign_id':'alpha','objective':'Scratch native fixture','scope_roots':[str(scope)],'actor':'owner'}
 with patch('tools.mcp_tool_handlers._trust_granted',return_value=False):
  with patch('tools.approval_prompt.request_elicitation_consent',return_value='deny'):
   denied=call('campaign_create',args);assert denied['code']=='ADAPTER_NATIVE_DENIED_OR_FAILED',denied
  with patch('tools.approval_prompt.request_elicitation_consent',return_value='accept'):
   assert call('campaign_list')['campaigns']==[]
   assert call('campaign_create',args)['version']==1
   detail=call('campaign_detail',{'campaign_id':'alpha'})
   bind={'campaign_id':'alpha','expected_version':1,'identity_digest':detail['identity_digest'],'actor':'owner','run_id':'native','thread_id':'FORGED'}
   assert call('campaign_bind',bind)['mode']=='BOUND_ACTIVE'
   status=call('campaign_status');assert status['campaign_id']=='alpha'
   assert status['bound_run']['thread_id']=='a',status
   assert call('campaign_status',sid='b')['code']=='CAMPAIGN_NOT_BOUND'
   call('campaign_unbind',sid='b')
   assert call('campaign_status')['campaign_id']=='alpha'
   assert call('campaign_status',{'session_id':'a'},sid='b')['code']=='ADAPTER_ROUTING_ARGUMENT'
   with session_tool_scope(mgr.scope_key):bridge.compact(session_id='rotated-a',old_session_id='a')
   assert call('campaign_status',sid='rotated-a')['campaign_id']=='alpha'
   assert call('campaign_status',sid='a')['code']=='CAMPAIGN_NOT_BOUND'
   with session_tool_scope(mgr.scope_key):assert bridge.checkpoint('rotated-a')['campaign_id']=='alpha'
   sid='rotated-a'
   def checked(name,args=None):
    value=call(name,args,sid=sid)
    assert 'code' not in value,(name,value)
    return value
   assert checked('campaign_search',{'query':'alpha'})['campaigns'][0]['campaign_id']=='alpha'
   assert checked('campaign_preflight')['campaign_id']=='alpha'
   assert call('campaign_bind',{**bind,'identity_digest':'0'*64},sid='other')['code']=='CAMPAIGN_IDENTITY_MISMATCH'
   assert call('campaign_bind',{**bind,'expected_version':0},sid='other')['code'] in ('CAMPAIGN_VERSION_CONFLICT','INVALID_INPUT')
   assert checked('campaign_work_package',{'expected_version':1,'actor':'owner','run_id':'native','work_package_id':'alpha-wp','title':'Review alpha','allowed_paths':[str(scope)]})['version']==2
   malformed=call('campaign_receipt',{'expected_version':2,'actor':'owner','run_id':'native','work_package_id':'alpha-wp','kind':'test','data':{'artifacts':[{'path':'missing'}]}},sid=sid)
   assert malformed['details']['mutated'] is False
   assert checked('campaign_receipt',{'expected_version':2,'actor':'owner','run_id':'native','work_package_id':'alpha-wp','kind':'test','data':{'summary':'Synthetic receipt','files_read':['fixture.json']}})['version']==3
   assert checked('campaign_reconcile',{'expected_version':3,'actor':'owner','run_id':'native','work_package_id':'alpha-wp','outcome':'accepted','details':{'review':'passed','evidence_summary':'Verified fixture','files_read':['fixture.json']}})['version']==4
   version=4
   for lifecycle in ['ORIENTING','READY','EXECUTING','VERIFYING','CLOSING']:
    version+=1
    assert checked('campaign_update',{'expected_version':version-1,'actor':'owner','lifecycle':lifecycle})['version']==version
   assert checked('campaign_finish',{'expected_version':version,'actor':'owner','run_id':'native','closure_kind':'FULL','closeout':{'final_inventory':['alpha-wp'],'limitations':[]}})['lifecycle']=='CLOSED'
   checked('campaign_unbind')
   assert call('campaign_bind',bind,sid=sid)['details']['mutated'] is False
   assert checked('campaign_create',{'campaign_id':'abandon-fixture','objective':'Abandon synthetic','scope_roots':[str(scope)],'actor':'owner'})['version']==1
   detail=checked('campaign_detail',{'campaign_id':'abandon-fixture'})
   checked('campaign_bind',{**bind,'campaign_id':'abandon-fixture','identity_digest':detail['identity_digest']})
   assert checked('campaign_abandon',{'expected_version':1,'actor':'owner','run_id':'native','reason':'Synthetic test finished','limitations':['Fixture only']})['lifecycle']=='ABORTED'
   checked('campaign_unbind')
 with patch.object(PluginContext,'_mcp_allowlist',return_value=[]):
  assert call('campaign_list')['code']=='ADAPTER_OUTCOME_UNKNOWN'
 print('CAMPAIGN_NATIVE_RECEIPT='+json.dumps({'native_denial_no_write':True,'accepted_fixture_readback':True,'trusted_bind_identity':True,'a_b_isolation':True,'trusted_compaction_rotation':True,'missing_allowlist_denied':True,'raw_router_tools_hidden':True,'all_14_operations_native_dispatch':True,'receipt_reconcile_full_close':True}),flush=True)
finally:
 bridge.close()
 with session_tool_scope(mgr.scope_key):shutdown_mcp_servers(scope=mgr.scope_key)
'''
    python=os.environ.get('HERMES_PYTHON',sys.executable)
    env={k:os.environ[k] for k in ('HOME','PATH','LANG','SystemRoot','WINDIR','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP','HERMES_DISABLE_LAZY_INSTALLS') if k in os.environ}
    env.update(TMPDIR=str(tmp_path),HERMES_SOURCE=os.environ['HERMES_SOURCE'])
    result=subprocess.run([python,'-c',code,str(ROOT),str(tmp_path),str(SOURCE),NODE],capture_output=True,text=True,timeout=60,env=env)
    assert result.returncode==0,result.stdout+result.stderr
    receipts=[line.split('CAMPAIGN_NATIVE_RECEIPT=',1)[1] for line in result.stdout.splitlines() if 'CAMPAIGN_NATIVE_RECEIPT=' in line]
    assert len(receipts)==1,result.stdout+result.stderr
    receipt=json.loads(receipts[0])
    assert all(receipt.values())
    (tmp_path/'native-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
