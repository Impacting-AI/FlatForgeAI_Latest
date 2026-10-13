"""Shared input contract and explicit bend policies; no panel-specific rules."""
import math
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator


class Parameters(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    thickness: float = Field(default=2, gt=0, le=20)
    radius: float = Field(default=2, gt=0, le=100)
    deduction: float = Field(default=4, ge=0, le=100)
    input_type: Literal['flat_pattern', 'folded_dimensions'] = 'flat_pattern'
    strip_tolerance: float = Field(default=.5, gt=0, le=5)
    angle_tolerance: float = Field(default=.1, ge=0, le=2)
    default_angle: float = Field(default=90, gt=0, lt=180)
    bend_model: Literal['constant_k', 'fixed_deduction'] = 'constant_k'


class BendOverride(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    angle: float | None = Field(default=None, gt=-180, lt=180)
    radius: float | None = Field(default=None, gt=0, le=100)
    deduction: float | None = Field(default=None, ge=0, le=100)

    @field_validator('angle')
    @classmethod
    def nonzero_angle(cls, value):
        if value == 0:
            raise ValueError('A bend rotation must be nonzero.')
        return value


DEFAULTS = Parameters().model_dump()


def normalized_angle(angle, tolerance=.1):
    """Only normalize near-square drawing turns, never arbitrary oblique folds."""
    return math.copysign(90., angle) if abs(abs(angle)-90.) <= tolerance else float(angle)


def allowance(t, r, bd, angle, model='constant_k'):
    if not math.isfinite(angle) or not 0 < abs(angle) < 180:
        raise ValueError('Bend rotation must be between 0 and 180 degrees.')
    if model == 'fixed_deduction':
        result = 2*(r+t)*math.tan(math.radians(abs(angle))/2)-bd
    elif model == 'constant_k':
        result = (2*(r+t)-bd)*abs(angle)/90.
    else:
        raise ValueError('Unknown bend calculation method.')
    return result


def hinge_parameters(edge, t, r, bd, model='constant_k'):
    radius = edge.get('radius', r)
    deduction = edge.get('deduction', bd)
    ba = allowance(t, radius, deduction, edge['angle'], model)
    if not math.isfinite(ba) or ba <= .001:
        raise ValueError(f"Bend {edge.get('review_key', edge.get('index'))}: settings leave no positive developed bend length. Reduce deduction or revise radius/angle.")
    k = (ba/math.radians(abs(edge['angle']))-radius)/t
    if model == 'constant_k' and not 0 < k < 1:
        raise ValueError(f"Bend {edge.get('review_key', edge.get('index'))}: the 90° calibration gives K={k:.4f}. Correct the values or explicitly choose the fixed-deduction shape model.")
    return radius, deduction, ba, k
