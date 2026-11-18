import concurrent.futures
import os
import threading
import time
from test_bridge import module, Context
from test_security import private_test_root

def private_channel_dir(tmp_path,mod):
    root=private_test_root(tmp_path)
    return mod.ensure_private_directory(root/'channels') if os.name=='nt' else root


def test_separate_conversations_are_not_serialized(tmp_path):
    entered=threading.Barrier(2)
    class Parallel(Context):
        def call_mcp(self,*args,**kwargs):
            entered.wait(timeout=2)
            return {'ok':True,'structuredContent':{'campaigns':[]}}
    mod=module();b=mod.Bridge(Parallel(),private_channel_dir(tmp_path,mod),'p')
    try:
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results=list(pool.map(lambda sid:b.call('campaign_list',{},session_id=sid),['a','b']))
        assert all(r.get('campaigns')==[] for r in results),results
    finally:b.close()


def test_release_and_close_release_owned_routes(tmp_path):
    mod=module();ctx=Context();b=mod.Bridge(ctx,private_channel_dir(tmp_path,mod),'p')
    b.call('campaign_bind',{},session_id='a')
    b.call('campaign_bind',{},session_id='b')
    b.release('a')
    b.close()
    import base64,json
    released=[json.loads(base64.b64decode(args['_adapter']['payload']))['route']
              for _,_,args in ctx.calls
              if json.loads(base64.b64decode(args['_adapter']['payload'])).get('control')=='release']
    assert sorted(released)==sorted([b.route('a'),b.route('b')])
    assert not list(b.directory.glob('*.key'))


def test_reminder_read_failure_is_not_retried_each_request(tmp_path):
    mod=module();ctx=Context();b=mod.Bridge(ctx,private_channel_dir(tmp_path,mod),'p')
    try:
        b.call('campaign_bind',{},session_id='a')
        b.compact(session_id='a')
        def fail(*args,**kwargs):
            ctx.calls.append(args)
            raise TimeoutError()
        ctx.call_mcp=fail
        assert b.checkpoint('a') is None
        assert b.checkpoint('a') is None
        assert len(ctx.calls)==2
    finally:b.close()


def test_write_does_not_drop_post_compaction_continuation(tmp_path):
    class Status(Context):
        def call_mcp(self,server,tool,arguments,timeout=30):
            if tool=='campaign_status':return {'ok':True,'structuredContent':{'campaign_id':'alpha','version':2}}
            return super().call_mcp(server,tool,arguments,timeout)
    mod=module();b=mod.Bridge(Status(),private_channel_dir(tmp_path,mod),'p')
    try:
        b.call('campaign_bind',{},session_id='a')
        b.compact(session_id='a')
        assert b.checkpoint('a')['version']==2
        b.call('campaign_update',{},session_id='a')
        assert b.checkpoint('a')['version']==2
        b.call('campaign_unbind',{},session_id='a')
        assert b.checkpoint('a') is None
    finally:b.close()
