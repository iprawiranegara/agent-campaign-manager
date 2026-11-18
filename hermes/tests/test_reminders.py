import copy
import importlib.util
from pathlib import Path
import pytest

ROOT=Path(__file__).resolve().parents[1]

def module():
    spec=importlib.util.spec_from_file_location('reminders_under_test',ROOT/'reminders.py')
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    return mod

def status():
    return {'campaign_id':'fixture','version':7,'objective':'Synthetic work','lifecycle':'EXECUTING','phase':'review',
            'work_packages':[{'package_id':'alpha','status':'ACCEPTED'},{'package_id':'beta','status':'READY'},
                             {'package_id':'cancelled','status':'CANCELLED'},{'package_id':'old','status':'SUPERSEDED'}],
            'gates':[{'gate_id':'approval','status':'OPEN'}],'next_permitted_actions':['campaign_receipt']}

def test_real_status_shape_separates_dispositions_and_outstanding():
    text=module().render_checkpoint(status())
    for expected in ['fixture','v7','1 accepted','1 cancelled','1 superseded','Outstanding: 1','beta (READY)','approval','campaign_receipt',"Owner's latest instructions"]:
        assert expected in text

def test_terminal_unbound_error_and_absent_status_are_silent():
    mod=module()
    for value in [None,{}, {'code':'INTERNAL_ERROR'},*[dict(status(),lifecycle=s) for s in ['CLOSED','CLOSED_QUALIFIED','ABORTED']]]:
        assert mod.render_checkpoint(value) is None

def test_bounded_checkpoint_has_exact_remainders():
    value=status();value['objective']='long '*3000
    value['work_packages']=[{'package_id':f'wp-{i}','status':'READY'} for i in range(8)]
    value['gates']=[{'gate_id':f'g-{i}','status':'OPEN'} for i in range(12)]
    text=module().render_checkpoint(value)
    assert len(text)<=2000
    assert 'Outstanding: 8' in text and '+3 more' in text
    assert 'Open gates: 12' in text and '+7 more' in text

@pytest.mark.parametrize('ending,parts', [('user',False),('user',True),('tool',False),('tool',True)])
def test_checkpoint_preserves_provider_roles_and_tool_pairs(ending,parts):
    mod=module();req={'model':'fixture','messages':[{'role':'system','content':'unchanged'}, {'role':'user','content':'steer'},
        {'role':'assistant','tool_calls':[{'id':'call-a','type':'function','function':{'name':'example','arguments':'{}'}}]},
        {'role':'tool','tool_call_id':'call-a','content':'result'}]}
    if ending=='user':req['messages'].append({'role':'user','content':'Continue'})
    if parts:
        req['messages'][-1]['content']=[{'type':'text','text':'original context'}]
        if ending=='user':req['messages'][-1]['content'].append({'type':'image_url','image_url':{'url':'https://example.invalid/fixture.png'}})
    original=copy.deepcopy(req)
    result=mod.insert_checkpoint(req,'checkpoint','chat_completions')
    assert req==original
    assert len(result['messages'])==len(original['messages'])
    assert result['messages'][:-1]==original['messages'][:-1]
    assert {k:v for k,v in result['messages'][-1].items() if k!='content'}=={k:v for k,v in original['messages'][-1].items() if k!='content'}
    content=result['messages'][-1]['content']
    if parts:
        assert content[:-1]==original['messages'][-1]['content']
        assert content[-1]['type']=='text' and mod.CHECKPOINT_MARKER in content[-1]['text']
    else:
        assert content.startswith(original['messages'][-1]['content']+'\n\n'+mod.CHECKPOINT_MARKER)
    assert mod.insert_checkpoint(result,'checkpoint','chat_completions')==result

@pytest.mark.parametrize('last', [
    {'role':'assistant','content':'unfinished assistant output'},
    {'role':'user','content':None},
    {'role':'tool','content':{'unsupported':'shape'}},
])
def test_checkpoint_does_not_extend_prefill_or_unsupported_content(last):
    req={'messages':[{'role':'system','content':'stable'},last]}
    original=copy.deepcopy(req)
    assert module().insert_checkpoint(req,'checkpoint','chat_completions')==original


def test_historical_checkpoint_does_not_suppress_current_tool_context():
    mod=module()
    req={'messages':[
        {'role':'user','content':'Earlier request\n\n'+mod.CHECKPOINT_MARKER+'\nold status'},
        {'role':'assistant','tool_calls':[{'id':'call-a','type':'function','function':{'name':'example','arguments':'{}'}}]},
        {'role':'tool','tool_call_id':'call-a','content':'new result'},
    ]}
    original=copy.deepcopy(req)
    result=mod.insert_checkpoint(req,'fresh status','chat_completions')
    assert req==original and result['messages'][:-1]==original['messages'][:-1]
    assert result['messages'][-1]['role']=='tool'
    assert result['messages'][-1]['content'].endswith(mod.CHECKPOINT_MARKER+'\nfresh status')
    assert mod.insert_checkpoint(result,'fresh status','chat_completions')==result

def test_unsupported_payload_and_incomplete_tools_are_unchanged():
    mod=module();req={'messages':[{'role':'user','content':'steer'}]}
    for mode in ['codex_responses','anthropic_messages','unknown']:
        assert mod.insert_checkpoint(req,'checkpoint',mode)==req
    pending={'messages':[{'role':'user','content':'x'},{'role':'assistant','tool_calls':[{'id':'call-a'}]}]}
    assert mod.insert_checkpoint(pending,'checkpoint','chat_completions')==pending
