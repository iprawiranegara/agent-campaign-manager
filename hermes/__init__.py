"""Hermes-native campaign tools; this package does not own campaign rules."""
import json
from pathlib import Path

def register(ctx):
    from .bridge import Bridge
    channel_dir=ctx.get_config('channel_dir','')
    if not channel_dir:
        from hermes_constants import get_hermes_home
        channel_dir=get_hermes_home()/'plugin-data'/'campaign-manager'/'channels'
    profile=str(Path(channel_dir).resolve())
    bridge=Bridge(ctx,channel_dir,profile)
    ctx.on_unload(bridge.close)
    definitions=json.loads((Path(__file__).parent/'schemas.json').read_text())
    for definition in definitions:
        name=definition['name']
        def handler(args,*,session_id=None,_tool=name,**kwargs):
            return json.dumps(bridge.call(_tool,args,session_id=session_id),ensure_ascii=False)
        ctx.register_tool(name=name,toolset='campaign',schema={
            'name':name,'description':definition['description']+' Hermes binds only this conversation; latest owner instructions control. No automatic write retry.',
            'parameters':definition['inputSchema']},handler=handler)
    ctx.register_hook('post_compaction',bridge.compact)
    def boundary(*,session_id=None,old_session_id=None,deleted_ids=None,**kwargs):
        for sid in set(deleted_ids or [old_session_id or session_id]):
            if sid:bridge.release(sid)
    for event in ('on_session_delete','on_session_reset','on_session_finalize'):
        ctx.register_hook(event,boundary)
    def request_context(request,*,session_id='',api_mode='',**kwargs):
        # Fail silent on modes without a verified payload projection.
        if api_mode!='chat_completions':return None
        from .reminders import render_checkpoint,insert_checkpoint
        with bridge.session_lock(session_id):
            status=bridge.checkpoint(session_id)
            text=render_checkpoint(status) if status else None
            if not text:return None
            return {'request':insert_checkpoint(request,text,api_mode),'source':'campaign-manager'}
    ctx.register_middleware('llm_request',request_context)
