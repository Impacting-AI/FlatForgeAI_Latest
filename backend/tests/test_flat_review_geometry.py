"""Review labels use the same hinge identity and boundaries as the CAD fold tree."""
import json
from pathlib import Path

import pytest
from shapely.geometry import LineString, shape, Polygon
from shapely.ops import unary_union

from flatforge import geometry as g
from flatforge.engine import extraction_data, json_safe, map_review, run
from test_complex_geometry import channel
from test_tolerant_review import without_sections


def check_geometry(source):
    doc, origin, outer, blank, lines = g.read_drawing(source)
    faces, edges, _, _, material = g.partition(outer, blank, lines, 3.)
    map_review(edges, {})
    data = json_safe(extraction_data(outer, blank, lines, faces, material, edges, doc, origin))
    assert data['version'] == 2 and data['units'] == 'mm'
    assert len(data['bends']) == len(edges)
    for exported, edge in zip(data['bends'], edges):
        assert exported['key'] == edge['review_key']
        assert (exported['parent'], exported['child']) == (edge['parent'], edge['child'])
        actual = unary_union([LineString(segment) for segment in exported['segments']])
        assert actual.equals(edge['geom'])
        assert actual.difference(faces[edge['parent']].boundary).length < 1e-8
        assert actual.difference(faces[edge['child']].boundary).length < 1e-8
    for exported, actual in zip(data['faces'], material):
        polygons = unary_union([Polygon(p['outer'], p['holes']) for p in exported['polygons']])
        assert polygons.equals(actual)
        assert exported['name'] == f"F{exported['id']}"
        assert polygons.covers(shape({'type': 'Point', 'coordinates': exported['label_point']}))
    return data


@pytest.mark.parametrize('plan', [0, 37, -31, 90])
def test_rotated_hinge_coordinates(tmp_path, plan):
    source = tmp_path/'arbitrary-name.dxf'
    channel(source, angle=60, plan=plan)
    check_geometry(source)


def test_repeated_source_ids_have_distinct_physical_segments():
    source = Path(__file__).resolve().parents[2]/'public/samples/1648/flat.dxf'
    data = check_geometry(source)
    groups = {}
    for bend in data['bends']:
        groups.setdefault(tuple(bend['bend_ids']), []).append(bend)
    repeated = [bends for bends in groups.values() if len(bends) > 1]
    assert repeated
    for bends in repeated:
        assert len({b['key'] for b in bends}) == len(bends)
        assert len({json.dumps(b['segments']) for b in bends}) == len(bends)


def test_review_geometry_available_without_angles_or_step(tmp_path):
    source = tmp_path/'no-sections.dxf'
    without_sections(source)
    out = tmp_path/'out'
    report = run({'source': str(source), 'output': str(out)})
    data = json.loads((out/'extraction.json').read_text())
    assert report['status'] == 'NEEDS_REVIEW'
    assert {b['key'] for b in data['bends']} == {b['key'] for b in report['bends']}
    assert all(b['angle'] is None for b in report['bends'])
    assert not (out/'panel.step').exists()
