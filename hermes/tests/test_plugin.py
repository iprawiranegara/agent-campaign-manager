import importlib.util
from pathlib import Path
import json
from test_security import private_test_root

ROOT=Path(__file__).resolve().parents[1]

def test_native_registration_all_schemas_no_routing_fields(tmp_path):
    channel_dir=private_test_root(tmp_path)/'channels'
    class Context:
        def __init__(self):self.tools={};self.hooks={};self.middlewares={};self.cleanup=[]
        def get_config(self,key,default=None):return str(channel_dir) if key=='channel_dir' else default
        def register_tool(self,**kw):self.tools[kw['name']]=kw
        def register_hook(self,name,callback):self.hooks[name]=callback
        def register_middleware(self,name,callback):self.middlewares[name]=callback
        def on_unload(self,callback):self.cleanup.append(callback)
        def call_mcp(self,*a,**kw):return {'ok':False,'error':'fixture denial'}
    spec=importlib.util.spec_from_file_location('staged_campaign_plugin',ROOT/'__init__.py',submodule_search_locations=[str(ROOT)])
    mod=importlib.util.module_from_spec(spec)
    import sys
    sys.modules[spec.name]=mod
    spec.loader.exec_module(mod)
    ctx=Context();mod.register(ctx)
    expected=json.loads((ROOT/'schemas.json').read_text())
    assert set(ctx.tools)=={t['name'] for t in expected}
    for definition in expected:
        schema=ctx.tools[definition['name']]['schema']
        assert schema['parameters']==definition['inputSchema']
        assert '_adapter' not in schema['parameters']['properties']
    assert 'post_compaction' in ctx.hooks
    assert {'on_session_delete','on_session_reset','on_session_finalize'} <= ctx.hooks.keys()
    assert 'llm_request' in ctx.middlewares
    result=json.loads(ctx.tools['campaign_list']['handler']({},session_id=None))
    assert result['code']=='ADAPTER_IDENTITY_REQUIRED'
    for cleanup in reversed(ctx.cleanup):cleanup()
    assert not list(channel_dir.glob('*.key'))
