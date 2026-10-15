"""Branch-only experiment: measure drawing differences without rejecting them.

Numerical CAD precision, angle evidence, missing data and solid validity are
unchanged. Restore the review branch to restore normal tolerance enforcement.
"""
import math

ENFORCE_DRAWING_TOLERANCES = False


def matching_candidates(candidates, tolerance, enforce=True):
    """Preserve existing matches; otherwise retain the closest geometric fit.

    Only the distance cutoff is bypassed. Equally close, distinct assignments
    remain ambiguous and still require the existing correspondence checks.
    """
    accepted=[c for c in candidates if c['error']<=tolerance]
    if enforce or accepted or not candidates:return accepted
    best=min(c['error'] for c in candidates)
    return [c for c in candidates if abs(c['error']-best)<=1e-6]


def structural_validation_failed(checks, unfold):
    """Failures that cannot be waived by disabling dimensional tolerances."""
    for check in checks:
        if check.get('missing_or_interrupted'):return True
        for field in ('max_length_error_mm','max_turn_error_deg','max_paint_normal_error_deg','max_radius_error_mm'):
            if field in check and not math.isfinite(check[field]):return True
        if check.get('max_radius_error_mm',0)>=.001:return True
    if unfold['flat_input_area_mm2']<=0 or unfold['unfolded_area_mm2']<=0:return True
    if unfold['plate_normal_check']['unobserved_plates']:return True
    return bool(unfold['local_boundary_check'].get('reason'))
