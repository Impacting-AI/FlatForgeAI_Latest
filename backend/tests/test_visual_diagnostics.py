"""Visual regression tests for section-cut location overlays."""
from shapely.geometry import Polygon
from flatforge.engine import annotate_section_svg


def test_failed_section_cut_is_highlighted_on_the_flat_pattern():
    outline = Polygon([(0, 0), (100, 0), (100, 50), (0, 50)])
    svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    result = annotate_section_svg(svg, outline, [{
        'profile': 'SECTION_02',
        'status': 'NEEDS_REVIEW',
        'reason': 'Closest chain exceeds strip tolerance.',
        'cut_axis': 'Y',
        'coordinate': 20.0,
    }])
    assert '#c43d36' in result
    assert 'SECTION_02' in result
    assert 'Closest chain exceeds strip tolerance.' in result
    assert 'M 0.000,30.000 L 100.000,30.000' in result


def test_successful_section_cut_uses_a_distinct_non_error_colour():
    outline = Polygon([(0, 0), (100, 0), (100, 50), (0, 50)])
    result = annotate_section_svg('<svg></svg>', outline, [{
        'profile': 'SECTION_01',
        'status': 'PASS',
        'cut_direction': [0.0, 1.0],
        'cut_coordinate': 40.0,
    }])
    assert '#367e9b' in result
    assert '#c43d36' not in result
