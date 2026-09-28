from pathlib import Path
from unittest.mock import Mock
import pytest
import bootstrap as b
from cpi_config import ROOT, ConfigError

@pytest.fixture
def root(tmp_path,monkeypatch):
    (tmp_path/'scripts').mkdir()
    for name in ('config-default.toml','requirements.txt'):
        (tmp_path/'scripts'/name).write_bytes((ROOT/'scripts'/name).read_bytes())
    return tmp_path

def test_supported():
    assert b.supported((3,11,0,'final',0))
    assert b.supported((3,14,0,'final',0))
    assert not b.supported((3,15,0,'final',0))
    assert not b.supported((3,14,0,'candidate',1))

def test_healthy_repeat(root,monkeypatch):
    monkeypatch.setattr(b,'probe',lambda *args:True)
    run=Mock()
    monkeypatch.setattr(b,'run_command',run)
    b.reconcile(root); b.reconcile(root)
    run.assert_not_called()
    assert (root/'config.toml').exists()

@pytest.mark.parametrize('existing',[False,True])
def test_missing_broken_venv(root,monkeypatch,existing):
    if existing:
        (root/'.venv').mkdir()
        (root/'.venv/broken').touch()
    monkeypatch.setattr(b,'probe',Mock(side_effect=[False,True,True]))
    def run(args,root):
        (root/'.venv/Scripts').mkdir(parents=True)
    monkeypatch.setattr(b,'run_command',run)
    b.reconcile(root)
    assert (root/'.venv/Scripts').exists()
    assert not list((root/'files/temp/bootstrap').glob('venv-backup-*'))

def test_rebuild_rollback(root,monkeypatch):
    (root/'.venv').mkdir()
    (root/'.venv/keep').touch()
    monkeypatch.setattr(b,'probe',lambda *args:False)
    monkeypatch.setattr(b,'run_command',Mock(side_effect=b.BootstrapError('failed')))
    with pytest.raises(b.BootstrapError): b.reconcile(root)
    assert (root/'.venv/keep').exists()

@pytest.mark.parametrize('damaged',[False,True])
def test_stale_or_missing_import(root,monkeypatch,damaged):
    monkeypatch.setattr(b,'probe',Mock(side_effect=[True,False,False,True] if damaged else [True,False,True,True]))
    run=Mock()
    monkeypatch.setattr(b,'run_command',run)
    b.reconcile(root)
    assert run.call_count == (3 if damaged else 2)
    assert any('--force-reinstall' in call.args[0] for call in run.call_args_list) == damaged

def test_malformed_config_stops_repair(root,monkeypatch):
    (root/'config.toml').write_text('broken = [')
    run=Mock()
    monkeypatch.setattr(b,'run_command',run)
    with pytest.raises(ConfigError): b.reconcile(root)
    run.assert_not_called()
    assert (root/'config.toml').read_text()=='broken = ['

def test_repair_containment(root):
    with pytest.raises(b.BootstrapError): b.contained(root,root)
    with pytest.raises(b.BootstrapError): b.contained(root.parent/'outside',root)
