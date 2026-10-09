"""Regression for a feasible cut lane rejected by least-squares placement."""
import numpy as np
from flatforge.section_mapping import minimax_station


def test_minimax_finds_feasible_station_that_least_squares_rejects():
    # Residuals x, 2(x-1): least squares selects 4/5 (max 4/5).
    # Rescale to put the minimax solution exactly on the 0.5 mm limit.
    start=np.array([10.,8.5])
    end=np.array([10.75,10.])
    expected=np.array([10.,10.])
    slope=end-start
    least_squares=float((expected-start)@slope/(slope@slope))
    assert np.max(abs(start+slope*least_squares-expected))>.5
    station=minimax_station(start,end,expected)
    assert abs(station-2/3)<1e-12
    assert np.max(abs(start+slope*station-expected))<=.5


def test_minimax_constant_lane_and_reversed_lane():
    assert minimax_station([3,4],[3,4],[3,4])==0
    forward=minimax_station([0,0],[1,2],[.3,1.5])
    backward=minimax_station([1,2],[0,0],[.3,1.5])
    assert abs(forward+backward-1)<1e-12


def test_minimax_does_not_hide_an_infeasible_lane():
    station=minimax_station([0,3],[1,4],[0,0])
    assert station==0
    assert max(abs(np.array([0,3])+station-np.array([0,0])))==3


def test_unmatched_section_keeps_separate_normal_and_projected_diagnostics(tmp_path):
    from test_complex_geometry import channel
    from flatforge import geometry as g
    from flatforge.section_mapping import map_normal_sections
    source=tmp_path/'section.dxf';channel(source,60)
    d,o,outer,blank,lines=g.read_drawing(source)
    f,e,_,_,_=g.partition(outer,blank,lines,3)
    profiles=g.profiles(d,o,2)
    profiles[0]['points'][0]+=g.unit(profiles[0]['points'][0]-profiles[0]['points'][1])*3
    rows=map_normal_sections(f,outer,e,profiles,2,2,4)
    row=rows[0]
    assert row['status']=='NEEDS_REVIEW'
    assert row['nearest_normal_candidate']['normal_to_all_hinges']
    assert row['nearest_normal_candidate']['max_strip_error_mm']>.5
    assert all('source_handles' in s for s in row['nearest_normal_candidate']['segment_checks'])
