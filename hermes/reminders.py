"""Read-only status projection; request copies never alter canonical history."""
from copy import deepcopy

CHECKPOINT_MARKER='<!-- hermes-campaign-checkpoint -->'
TERMINAL={'CLOSED','CLOSED_QUALIFIED','ABORTED'}


def render_checkpoint(status):
    if not isinstance(status,dict) or status.get('code') or status.get('lifecycle') in TERMINAL:
        return None
    if not all(status.get(k) is not None for k in ('campaign_id','version','objective','lifecycle')):
        return None
    packages=status.get('work_packages',[])
    counts={s:sum(p.get('status')==s for p in packages) for s in ('ACCEPTED','CANCELLED','SUPERSEDED')}
    outstanding=[p for p in packages if p.get('status') not in counts]
    gates=[g for g in status.get('gates',[]) if g.get('status')=='OPEN']
    def summary(items,format_item):
        text=', '.join(format_item(item) for item in items[:5]) or 'none'
        return text+(f' (+{len(items)-5} more)' if len(items)>5 else '')
    text='\n'.join([
        '[Campaign checkpoint: read-only advisory]',
        f"Campaign: {status['campaign_id']} v{status['version']}",
        f"Objective: {str(status['objective'])[:300]}",
        f"Lifecycle: {status['lifecycle']}; phase: {status.get('phase','unknown')}",
        f"{counts['ACCEPTED']} accepted; {counts['CANCELLED']} cancelled; {counts['SUPERSEDED']} superseded",
        f"Outstanding: {len(outstanding)}: "+summary(outstanding,lambda p:f"{p['package_id']} ({p['status']})"),
        f"Open gates: {len(gates)}: "+summary(gates,lambda g:g['gate_id']),
        'Next permitted actions: '+', '.join(status.get('next_permitted_actions',[])),
        "Owner's latest instructions control steering and cancellation. Outstanding work remains unless explicitly cancelled.",
    ])
    # Never emit a truncated identity/count or an incorrect remainder.
    return text if len(text)<=2000 else None


def insert_checkpoint(request,text,api_mode):
    if api_mode!='chat_completions' or not isinstance(request,dict) or not text:
        return request
    messages=request.get('messages')
    if not isinstance(messages,list) or not messages:return request
    if CHECKPOINT_MARKER in str(messages[-1].get('content','')):return request
    pending=set()
    for message in messages:
        for call in message.get('tool_calls',[]):pending.add(call['id'])
        if message.get('role')=='tool':pending.discard(message.get('tool_call_id'))
    if pending:return request
    last=messages[-1]
    if last.get('role') not in ('user','tool') or not isinstance(last.get('content'),(str,list)):
        return request
    result=deepcopy(request)
    last=result['messages'][-1]
    content=CHECKPOINT_MARKER+'\n'+text
    # User/tool context keeps the provider ending valid and the system prefix stable.
    if isinstance(last['content'],str):
        last['content']+='\n\n'+content
    else:
        last['content'].append({'type':'text','text':content})
    return result
