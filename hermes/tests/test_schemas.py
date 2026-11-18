import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]
NODE=__import__('os').environ.get('CAMPAIGN_NODE', 'node')
SOURCE=(ROOT.parent/'plugin/packages/codex-mcp/src/tools.mjs').as_uri()

def test_schema_snapshot_matches_existing_server():
    original=json.loads(subprocess.check_output([NODE,'--input-type=module','-e',f'import {{TOOL_DEFINITIONS}} from "{SOURCE}";console.log(JSON.stringify(TOOL_DEFINITIONS))'],text=True))
    snapshot=json.loads((ROOT/'schemas.json').read_text())
    assert snapshot==original
    assert len(snapshot)==14
