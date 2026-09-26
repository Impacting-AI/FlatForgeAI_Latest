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
