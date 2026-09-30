import json
import pytest
from flatforge.batch_audit import audit


def test_audit_isolates_exceptions_and_records_exact_source(monkeypatch,tmp_path):
    from flatforge import batch_audit as module
    source=tmp_path/'input';source.mkdir()
    (source/'a.dxf').write_text('bad');(source/'b.DXF').write_text('good')
    def run(config):
        if config['source'].endswith('a.dxf'):raise ValueError('Invalid contour')
        return {'status':'NEEDS_REVIEW','issues':[{'code':'DIRECTIONS'}]}
    monkeypatch.setattr(module,'run',run)
    rows=audit(source,tmp_path/'output')
    assert [r['status'] for r in rows]==['FAILED','NEEDS_REVIEW']
    assert len(rows[0]['sha256'])==64
    assert 'Invalid contour' in rows[0]['error']
    assert json.loads((tmp_path/'output/summary.json').read_text())==rows
    with pytest.raises(ValueError,match='already exists'):audit(source,tmp_path/'output')


def test_output_cannot_become_a_new_input(tmp_path):
    with pytest.raises(ValueError,match='outside'):audit(tmp_path,tmp_path/'output')
