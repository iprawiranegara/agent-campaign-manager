"""Cross-platform private-path contracts for the public Node setup helper."""
import json
import os
from pathlib import Path
import secrets
import subprocess

import pytest

ROOT=Path(__file__).resolve().parents[1]
NODE=os.environ.get('CAMPAIGN_NODE','node')

def private_test_root(tmp_path):
    if os.name!='nt':return tmp_path.resolve()
    root=Path(os.environ['LOCALAPPDATA'])/'campaign-manager-private-path-tests'
    module=(ROOT/'security.mjs').as_uri()
    script=f"import {{ensurePrivateDirectory}} from {json.dumps(module)};ensurePrivateDirectory(process.argv[1]);"
    subprocess.run([NODE,'--input-type=module','-e',script,str(root)],check=True,capture_output=True,text=True)
    child=root/(tmp_path.name+'-'+secrets.token_hex(6))
    result=run_node('ensurePrivateDirectory',child)
    assert result.returncode==0,result.stdout+result.stderr
    return child

def run_node(operation,path):
    module=(ROOT/'security.mjs').as_uri()
    args="process.argv[1], 'directory'" if operation=='verifyPrivatePath' else "process.argv[1]"
    script=f"import {{{operation}}} from {json.dumps(module)};console.log({operation}({args}));"
    return subprocess.run([NODE,'--input-type=module','-e',script,str(path)],capture_output=True,text=True,timeout=15)

def test_setup_helper_creates_nested_unicode_path_privately(tmp_path):
    target=private_test_root(tmp_path)/'profile space Ω'/'plugin-data'/'campaign-manager'/'channels'
    result=run_node('ensurePrivateDirectory',target)
    assert result.returncode==0,result.stdout+result.stderr
    assert target.is_dir()
    if os.name=='posix':
        current=target
        while current!=tmp_path.resolve():
            assert current.stat().st_mode & 0o777==0o700
            current=current.parent

def test_setup_helper_does_not_repair_an_insecure_existing_directory(tmp_path):
    if os.name!='posix':pytest.skip('ACL mutation is covered by native Windows DACL tests')
    target=private_test_root(tmp_path)/'preexisting'
    target.mkdir(mode=0o700)
    target.chmod(0o777)
    result=run_node('ensurePrivateDirectory',target)
    assert result.returncode!=0
    assert target.stat().st_mode & 0o777==0o777

def test_setup_helper_rejects_a_symlink_at_the_private_directory_path(tmp_path):
    if os.name!='posix':pytest.skip('NTFS junction check is covered by native Windows tests')
    root=private_test_root(tmp_path)
    target=root/'real'
    target.mkdir(mode=0o700)
    link=root/'link'
    link.symlink_to(target,target_is_directory=True)
    result=run_node('verifyPrivatePath',link)
    assert result.returncode!=0

def test_windows_nonempty_key_cannot_be_acl_repaired(tmp_path):
    if os.name!='nt':pytest.skip('Windows key ACL behavior requires native Windows')
    import importlib.util
    spec=importlib.util.spec_from_file_location('nonempty_key_security_test',ROOT/'bridge.py')
    bridge=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    target=private_test_root(tmp_path)/'existing.key'
    descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(descriptor,'wb') as stream:stream.write(b'preserve-existing-secret')
    acl=subprocess.run(['icacls',str(target),'/grant','*S-1-1-0:F'],capture_output=True,text=True,timeout=10)
    assert acl.returncode==0,acl.stdout+acl.stderr
    with pytest.raises(ValueError,match='empty key file'):
        bridge.secure_new_key(target)
    assert target.read_bytes()==b'preserve-existing-secret'
    with pytest.raises(ValueError,match='DACL|security check failed'):
        bridge.verify_private_path(target,'key')
