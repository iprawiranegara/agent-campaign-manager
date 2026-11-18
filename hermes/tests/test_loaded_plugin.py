"""Real native loader, hook dispatcher and middleware; fixture-only state."""
import os
from pathlib import Path
import subprocess
import sys
import shutil
from test_router import ROOT,SOURCE,NODE


import pytest
pytestmark = pytest.mark.skipif(not os.environ.get('HERMES_SOURCE'), reason='Set HERMES_SOURCE to run optional native Hermes integration')

def test_loaded_plugin_committed_compaction_and_deferred_catalog(tmp_path):
    code=r'''
import os,sys,json,subprocess,copy,shutil,importlib.util
test_sites=json.loads(os.environ['CAMPAIGN_TEST_SITES'])
sys.path.insert(0,os.environ['HERMES_SOURCE'])
import hermes_bootstrap
sys.path.extend(test_sites)
from pathlib import Path
from unittest.mock import patch
root,tmp,source,node=Path(sys.argv[1]),Path(sys.argv[2]),Path(sys.argv[3]),sys.argv[4]
spec=importlib.util.spec_from_file_location('campaign_bridge_setup',root/'bridge.py');security=importlib.util.module_from_spec(spec);spec.loader.exec_module(security)
home=security.ensure_private_directory(tmp/'home');channels=security.ensure_private_directory(home/'channels');state=tmp/'state';state.mkdir();scope=tmp/'scope';scope.mkdir()
os.environ['HERMES_HOME']=str(home)
sys.path.insert(0,os.environ['HERMES_SOURCE'])
(home/'plugins').mkdir();plugin_link=home/'plugins'/'campaign-manager'
try:plugin_link.symlink_to(root,target_is_directory=True)
except OSError:shutil.copytree(root,plugin_link)
(home/'config.yaml').write_text('plugins:\n  enabled: [campaign-manager]\n  entries:\n    campaign-manager:\n      mcp_allowlist: [campaign-router]\n      settings:\n        channel_dir: '+str(channels)+'\n')
subprocess.run([node,'--input-type=module','-e',f"import {{createStore}} from {json.dumps((source/'packages/campaign-core/src/core.mjs').as_uri())};const s=createStore({{dbPath:{json.dumps(str(state/'campaigns.sqlite3'))},allowCreate:true}});s.dispose();"],check=True,capture_output=True)
from hermes_cli import plugins
from tools.registry import registry,session_tool_scope
from tools.mcp_tool_discovery import register_mcp_servers
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
from hermes_cli.middleware import apply_llm_request_middleware
from tools.tool_search import dispatch_tool_search,dispatch_tool_describe
from agent.compaction_events import fire_post_compaction
mgr=plugins.get_plugin_manager();mgr.discover_and_load()
manifest=mgr._plugins['campaign-manager'];assert not manifest.error,manifest.error
sid='fixture-chat-a'
def call(name,args=None,session=sid):
 with session_tool_scope(mgr.scope_key):return json.loads(registry.dispatch(name,args or {},session_id=session,scope=mgr.scope_key))
def request(session=sid,messages=None):
 value={'model':'fixture','messages':messages if messages is not None else [{'role':'system','content':'unchanged system'},{'role':'user','content':'Latest owner steer'}]}
 original=copy.deepcopy(value)
 with session_tool_scope(mgr.scope_key):out=apply_llm_request_middleware(value,session_id=session,api_mode='chat_completions')
 assert value==original
 return out.payload
try:
 with session_tool_scope(mgr.scope_key):
  register_mcp_servers({'campaign-router':{'command':node,'args':[str(root/'router.mjs'),'--channels',str(channels),'--state',str(state),'--fixture','--fixture-root',str(tmp)],'cwd':str(root),'tools':{'include':[]},'resources':False,'prompts':False,'trust':'untrusted','lazy':False}})
 definitions=[{'type':'function','function':{'name':d['name'],'description':d['description'],'parameters':d['inputSchema']}} for d in json.loads((root/'schemas.json').read_text())]
 with session_tool_scope(mgr.scope_key):
  found=json.loads(dispatch_tool_search({'queries':['campaign status']},current_tool_defs=definitions))
  assert 'campaign_status' in found['tools'],found
  described=json.loads(dispatch_tool_describe({'names':['campaign_status']},current_tool_defs=definitions))
  assert 'campaign_status' in described['tools'],described
 with patch('tools.mcp_tool_handlers._trust_granted',return_value=False),patch('tools.approval_prompt.request_elicitation_consent',return_value='accept'):
  assert call('campaign_list')['campaigns']==[]
  made=call('campaign_create',{'campaign_id':'reminder-fixture','objective':'Accepted alpha and outstanding beta','scope_roots':[str(scope)],'actor':'owner'})
  bound=call('campaign_bind',{'campaign_id':'reminder-fixture','expected_version':1,'identity_digest':made['identity_digest'],'actor':'owner','run_id':'native','thread_id':'ignored'})
  assert bound.get('mode')=='BOUND_ACTIVE',bound
  version=1
  def mutate(name,args):
   global version
   result=call(name,{'expected_version':version,'actor':'owner','run_id':'native',**args});assert 'code' not in result,result
   version=result['version'];return result
  mutate('campaign_work_package',{'work_package_id':'alpha','title':'Accepted fixture','allowed_paths':[str(scope)]})
  mutate('campaign_receipt',{'work_package_id':'alpha','kind':'test','data':{'summary':'Completed alpha','files_read':['fixture']}})
  mutate('campaign_reconcile',{'work_package_id':'alpha','outcome':'accepted','details':{'review':'passed','evidence_summary':'Fixture evidence','files_read':['fixture']}})
  mutate('campaign_work_package',{'work_package_id':'beta','title':'Outstanding fixture','allowed_paths':[str(scope)]})
  assert len(request()['messages'])==2
  # Real compression implementation, synthetic summary source. This is not Desktop E2E evidence.
  from tests.agent.test_compaction_events import _Agent,_compressor,_messages
  from agent.conversation_compression import compress_context
  agent=_Agent(_compressor());agent.session_id=sid
  with patch.object(agent.context_compressor,'_generate_summary',return_value='Fixture compressed context'):
   compressed,_=compress_context(agent,_messages(),'unchanged system',approx_tokens=80000,trigger='post_tool')
  assert len(compressed)<len(_messages())
  first=request();text=first['messages'][-1]['content']
  assert '1 accepted' in text and 'Outstanding: 1' in text and 'beta' in text,text
  assert [m['role'] for m in first['messages']]==['system','user']
  assert first['messages'][0]['content']=='unchanged system'
  tool_messages=[{'role':'system','content':'unchanged system'},copy.deepcopy(first['messages'][-1]),
    {'role':'assistant','tool_calls':[{'id':'fixture-call','type':'function','function':{'name':'example','arguments':'{}'}}]},
    {'role':'tool','tool_call_id':'fixture-call','content':'fixture result'}]
  continued=request(messages=tool_messages)['messages']
  assert [m['role'] for m in continued]==['system','user','assistant','tool']
  assert continued[-1]['tool_call_id']=='fixture-call' and 'beta' in continued[-1]['content']
  assert continued[:-1]==tool_messages[:-1]
  assert request()['messages'][-1]['content']==text
  assert len(request('fixture-chat-b')['messages'])==2
  call('campaign_unbind',session='fixture-chat-b')
  assert 'beta' in request()['messages'][-1]['content']
  plugins.invoke_hook('on_session_delete',session_id='fixture-chat-b')
  assert call('campaign_status')['campaign_id']=='reminder-fixture'
  call('campaign_unbind')
  assert len(request()['messages'])==2
  assert call('campaign_status')['code']=='CAMPAIGN_NOT_BOUND'
 receipt={'real_plugin_loader':True,'deferred_search_describe':True,'real_compaction_with_fixture_summary':True,'next_request_checkpoint':True,'accepted_alpha_outstanding_beta':True,'continuation_repeat_no_accumulation':True,'other_chat_silent':True,'unbind_removes_checkpoint':True,'actual_desktop_e2e':False}
 (tmp/'loaded-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt))
finally:
 mgr.unload('campaign-manager')
 with session_tool_scope(mgr.scope_key):shutdown_mcp_servers(scope=mgr.scope_key)
'''
    python=os.environ.get('HERMES_PYTHON',sys.executable)
    env={k:os.environ[k] for k in ('HOME','PATH','LANG','SystemRoot','WINDIR','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','TEMP','TMP','HERMES_DISABLE_LAZY_INSTALLS') if k in os.environ}
    env.update(TMPDIR=str(tmp_path),PYTHONPATH=os.environ['HERMES_SOURCE'],HERMES_SOURCE=os.environ['HERMES_SOURCE'],CAMPAIGN_TEST_SITES=__import__('json').dumps(__import__('site').getsitepackages()))
    result=subprocess.run([python,'-c',code,str(ROOT),str(tmp_path),str(SOURCE),NODE],capture_output=True,text=True,timeout=80,env=env)
    assert result.returncode==0,result.stdout+result.stderr
