"""Exact CAD bounds/validation and STEP export of the viewer's shared transforms.

Live placement is calculated once by assembly_connections from CAD faces and
bounds. Preview and STEP export consume those same validated rigid matrices.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import tempfile
import threading
from functools import lru_cache
from pathlib import Path
from typing import Literal

import cadquery as cq
from fastapi import HTTPException
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.gp import gp_Trsf
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .db import Session, Panel, Project
from .storage import store
from . import assembly_connections as connections
import numpy as np

CAD_LOCK = threading.RLock()
LINEAR_EPS_MM = 1e-5
VOLUME_EPS_MM3 = 1e-6
AXES = ('x', 'y', 'z')
Face = Literal['+X', '-X', '+Y', '-Y', '+Z', '-Z']


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class Vector(StrictModel):
    x: float = 0
    y: float = 0
    z: float = 0


class AxisGap(StrictModel):
    side: Literal[-1, 0, 1]
    gap: float = Field(ge=0)


class Spacing(StrictModel):
    x: AxisGap
    y: AxisGap
    z: AxisGap


class FaceReference(StrictModel):
    faceId: str = Field(pattern=r'^face-[1-9][0-9]*$')
    sourceSha: str = Field(pattern=r'^[0-9a-f]{64}$')
    point: tuple[float, float, float]


class FaceConnection(StrictModel):
    type: Literal['planar'] = 'planar'
    reference: FaceReference
    moving: FaceReference
    offsetU: float = 0
    offsetV: float = 0
    normalOffset: float = 0
    twist: float = 0


class SourceReference(StrictModel):
    id: str = Field(min_length=1, max_length=160)
    panelId: str = Field(min_length=1, max_length=160)
    revision: int = Field(ge=1)


class Entry(SourceReference):
    myFace: Face
    targetId: str | None
    targetFace: Face | None
    gap: float = Field(ge=0)
    offsets: Vector = Field(default_factory=Vector)
    spacing: Spacing | None = None
    rotation: tuple[float, float, float, float] = (0, 0, 0, 1)
    matrix: list[float] | None = Field(default=None, min_length=16, max_length=16)
    connection: FaceConnection | None = None
    rootOffset: tuple[float, float, float] | None = None

    @model_validator(mode="after")
    def valid_connection(self):
        if self.rootOffset is not None and self.targetId is not None:
            raise ValueError('Only the root can have an assembly-origin offset')
        if self.connection and (self.targetId is None or self.gap + self.connection.normalOffset < 0):
            raise ValueError("A face connection needs a reference panel and a non-negative effective gap")
        return self

    @field_validator('rotation')
    @classmethod
    def unit_rotation(cls, value):
        if abs(sum(n*n for n in value)-1) > 1e-8:
            raise ValueError('Panel rotation must be a unit quaternion')
        return value


class AssemblyInput(StrictModel):
    entries: list[Entry] = Field(min_length=1, max_length=100)

    @model_validator(mode='after')
    def connection_tree(self):
        seen = set()
        for i, entry in enumerate(self.entries):
            if entry.id in seen:
                raise ValueError('Assembly entry IDs must be unique')
            if i == 0:
                if entry.targetId is not None or entry.targetFace is not None:
                    raise ValueError('The first panel must be the assembly root')
            elif entry.targetId not in seen or entry.targetFace is None:
                raise ValueError('Each panel must connect to an earlier assembly entry')
            seen.add(entry.id)
        return self


class ExportInput(StrictModel):
    token: str = Field(min_length=1, max_length=300000)


def rotation_matrix(quaternion):
    x, y, z, w = quaternion
    # Column-major, identical convention to Three.js; translation is in mm.
    return [1-2*(y*y+z*z), 2*(x*y+z*w), 2*(x*z-y*w), 0,
            2*(x*y-z*w), 1-2*(x*x+z*z), 2*(y*z+x*w), 0,
            2*(x*z+y*w), 2*(y*z-x*w), 1-2*(x*x+y*y), 0,
            0, 0, 0, 1]


def location(matrix):
    transform = gp_Trsf()
    transform.SetValues(*[matrix[column*4+row] for row in range(3) for column in range(4)])
    return cq.Location(transform)


def bounds(shape):
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape.wrapped, box, False, False)
    values = box.Get()
    return {'min': list(values[:3]), 'max': list(values[3:])}


@lru_cache(maxsize=24)
def read_solid(key):
    # Worker artifact keys include the immutable job ID. Never read mesh/STL.
    with tempfile.TemporaryDirectory(prefix='ff-assembly-source-') as directory:
        path = Path(directory)/'source.step'
        store.get(key, path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        imported = cq.importers.importStep(str(path))
        shape = cq.Compound.makeCompound([v for v in imported.vals() if isinstance(v, cq.Shape)])
        if not shape.Solids() or not shape.isValid():
            raise ValueError('Source STEP does not contain valid CAD solids')
        return shape, digest


@lru_cache(maxsize=24)
def source_faces(key):
    return connections.face_catalog(read_solid(key)[0])


@lru_cache(maxsize=12)
def source_pick_meshes(key):
    return connections.pick_meshes(source_faces(key))


def faces(project_id, body):
    with CAD_LOCK:
        source = load_sources(project_id, [body])[body.id]
        return {'entryId': body.id, 'revision': body.revision, 'sourceSha': source['sha256'],
                'units': 'mm', 'faces': source_pick_meshes(source['key'])}


def place(project_id, body):
    with CAD_LOCK:
        sources = load_sources(project_id, body.entries)
        try:
            return connections.solve(body.entries, sources, rotation_matrix, bounds)
        except HTTPException:
            raise
        except Exception as error:
            raise HTTPException(422, 'CAD face placement failed. Check the selected surfaces and connection values.') from error


def load_sources(project_id, entries):
    sources = {}
    with Session() as session:
        project = session.get(Project, project_id)
        if not project or project.deleted_at is not None:
            raise HTTPException(404, 'Project not found')
        for entry in entries:
            panel = session.get(Panel, entry.panelId)
            if not panel or panel.deleted_at is not None or panel.project_id != project_id:
                raise HTTPException(404, 'An assembly drawing is not available in this project')
            if panel.revision != entry.revision:
                raise HTTPException(409, 'An assembly drawing changed. Reload the current panel results before exporting.')
            key = json.loads(panel.artifacts).get('panel.step')
            if panel.status != 'PASS' or not key:
                raise HTTPException(409, f'{panel.filename}: complete the drawing review before CAD assembly or export')
            try:
                shape, digest = read_solid(key)
            except Exception as error:
                raise HTTPException(409, f'{panel.filename}: source STEP is unavailable or invalid') from error
            sources[entry.id] = {'shape': shape, 'sha256': digest, 'key': key, 'name': panel.filename, 'faces': source_faces(key)}
    return sources


def geometry(project_id, body):
    with CAD_LOCK:
        sources = load_sources(project_id, body.entries)
        return {'units': 'mm', 'entries': [
            {'id': entry.id, 'revision': entry.revision,
             'bounds': bounds(sources[entry.id]['shape'].moved(location(rotation_matrix(entry.rotation))))}
            for entry in body.entries]}


def validate_matrices(entries):
    for entry in entries:
        if entry.matrix is None:
            raise HTTPException(422, 'The current preview transformation is required for every panel')
        transform = connections.matrix(entry.matrix)
        r = transform[:3, :3]
        if not np.allclose(transform[3], [0, 0, 0, 1], atol=1e-8, rtol=0) or not np.allclose(r.T @ r, np.eye(3), atol=1e-8, rtol=0) or abs(np.linalg.det(r) - 1) > 1e-8:
            raise HTTPException(422, 'Assembly transforms must be proper rigid rotations without scaling or reflection')
        if entry.connection:
            continue
        rotation = rotation_matrix(entry.rotation)
        if any(abs(entry.matrix[i]-rotation[i]) > 1e-8 for i in range(16) if i not in (12, 13, 14)):
            raise HTTPException(422, 'Assembly transforms must preserve the specified rotation and unit scale')


def check_placement(entries, sources):
    validate_matrices(entries)
    shapes = {e.id: sources[e.id]['shape'].moved(location(e.matrix)) for e in entries}
    boxes = {key: bounds(shape) for key, shape in shapes.items()}
    clearances, collisions, contacts, issues = [], [], [], []
    matrices = {e.id: connections.matrix(e.matrix) for e in entries}
    for entry in entries[1:]:
        if entry.connection:
            row, conflicts = connections.measure_connection(entry, sources, matrices, LINEAR_EPS_MM)
            clearances.append(row)
            issues.extend(conflicts)
            continue
        own, target = boxes[entry.id], boxes[entry.targetId]
        axis = AXES.index(entry.targetFace[1].lower())
        side = 1 if entry.targetFace[0] == '+' else -1
        opposing = entry.myFace[1] == entry.targetFace[1] and entry.myFace[0] != entry.targetFace[0]
        if not opposing:
            issues.append(f'{entry.id}: choose opposing envelope faces; this connection cannot establish a gap.')
            continue
        constraints = entry.spacing.model_dump() if entry.spacing else {AXES[axis]: {'side': side, 'gap': entry.gap}}
        normal = constraints[AXES[axis]]
        if normal['side'] != side or normal['gap'] != entry.gap:
            issues.append(f'{entry.id}: connection face and directional gap disagree.')
        for name, constraint in constraints.items():
            if not constraint['side']:
                continue
            i = AXES.index(name)
            actual = own['min'][i]-target['max'][i] if constraint['side'] == 1 else target['min'][i]-own['max'][i]
            satisfied = abs(actual-constraint['gap']) <= LINEAR_EPS_MM
            clearances.append({'entryId': entry.id, 'targetId': entry.targetId, 'axis': name,
                               'side': constraint['side'], 'requested': constraint['gap'], 'actual': actual, 'satisfied': satisfied})
            if not satisfied:
                issues.append(f'{entry.id}: {name.upper()} clearance is {actual:.6g} mm; requested {constraint["gap"]:.6g} mm.')
    for index, a in enumerate(entries):
        for b in entries[index+1:]:
            ba, bb = boxes[a.id], boxes[b.id]
            overlap = [min(ba['max'][i], bb['max'][i])-max(ba['min'][i], bb['min'][i]) for i in range(3)]
            if min(overlap) < -LINEAR_EPS_MM:
                continue
            # Exact BREP common volume catches edge-through-face intersections
            # that sampled mesh vertices and ray parity can miss.
            common = shapes[a.id].intersect(shapes[b.id])
            if not common.isValid():
                raise ValueError('CAD intersection check failed; export has been stopped')
            volume = sum(abs(solid.Volume()) for solid in common.Solids())
            if volume > VOLUME_EPS_MM3:
                collisions.append({'entryIdA': a.id, 'entryIdB': b.id, 'volume': volume, 'depth': max(0, min(overlap)), 'pointCount': 0})
            elif shapes[a.id].distance(shapes[b.id]) <= LINEAR_EPS_MM:
                contacts.append({'entryIdA': a.id, 'entryIdB': b.id})
    return {'valid': not issues and not collisions, 'clearances': clearances, 'collisions': collisions,
            'contacts': contacts, 'issues': issues, 'bounds': boxes}, shapes


def sign(payload):
    raw = json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    encoded = base64.urlsafe_b64encode(raw).decode()
    signature = hmac.new(os.environ['FLATFORGE_API_KEY'].encode(), encoded.encode(), hashlib.sha256).hexdigest()
    return encoded + '.' + signature


def unsign(token):
    try:
        encoded, supplied = token.rsplit('.', 1)
        expected = hmac.new(os.environ['FLATFORGE_API_KEY'].encode(), encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(supplied, expected):
            raise ValueError('Invalid signature')
        return json.loads(base64.urlsafe_b64decode(encoded))
    except Exception as error:
        raise HTTPException(422, 'Assembly validation expired or changed. Validate the current layout again.') from error


def validate(project_id, body):
    with CAD_LOCK:
        sources = load_sources(project_id, body.entries)
        try:
            result, _ = check_placement(body.entries, sources)
        except HTTPException:
            raise
        except Exception as error:
            raise HTTPException(422, 'CAD clearance validation failed; no export was approved') from error
        result['token'] = sign({'version': 1, 'project': project_id, 'entries': body.model_dump()['entries'],
                                'sources': {key: {'key': source['key'], 'sha256': source['sha256']} for key, source in sources.items()}}) if result['valid'] else None
        return result


def export_step(project_id, token, path):
    payload = unsign(token)
    if payload.get('version') != 1 or payload.get('project') != project_id:
        raise HTTPException(422, 'Validate this project assembly before exporting')
    body = AssemblyInput(entries=payload['entries'])
    with CAD_LOCK:
        sources = load_sources(project_id, body.entries)
        for key, source in sources.items():
            if payload['sources'].get(key) != {'key': source['key'], 'sha256': source['sha256']}:
                raise HTTPException(409, 'A source STEP changed after validation. Reload the assembly.')
        # Use precisely the signed preview matrices. Never recalculate placement.
        result, shapes = check_placement(body.entries, sources)
        if not result['valid']:
            raise HTTPException(409, 'Assembly has clearance conflicts or intersecting solids; correct the layout before export')
        assembly = cq.Assembly(name='FlatForge Assembly')
        for i, entry in enumerate(body.entries):
            name = re.sub(r'[^\w .-]', '_', sources[entry.id]['name'])[:100]
            identity = re.sub(r'[^\w .-]', '_', entry.id)
            assembly.add(sources[entry.id]['shape'], name=f'{i+1:03d}_{name}_{identity}', loc=location(entry.matrix))
        from cadquery.occ_impl.exporters.assembly import exportAssembly
        from OCP.Interface import Interface_Static
        Interface_Static.SetCVal_s('write.step.unit', 'MM')
        if not exportAssembly(assembly, str(path), mode='default'):
            raise HTTPException(500, 'CAD assembly writer failed')
        # Re-import as real solids before delivering a complete file.
        imported = cq.importers.importStep(str(path))
        roundtrip = cq.Compound.makeCompound([v for v in imported.vals() if isinstance(v, cq.Shape)])
        expected = [solid for shape in shapes.values() for solid in shape.Solids()]
        actual = roundtrip.Solids()
        if not roundtrip.isValid() or len(actual) != len(expected):
            raise HTTPException(500, 'Assembly STEP failed the solid-count or validity check')
        # Match each solid by placed bounds and volume, not STEP entity order.
        for solid in expected:
            box = bounds(solid)
            match = next((j for j, candidate in enumerate(actual)
                          if abs(candidate.Volume()-solid.Volume()) <= max(1e-5, abs(solid.Volume())*1e-7)
                          and max(abs(x-y) for side in ('min', 'max') for x, y in zip(box[side], bounds(candidate)[side])) <= LINEAR_EPS_MM), None)
            if match is None:
                raise HTTPException(500, 'Assembly STEP failed geometry or placement verification')
            actual.pop(match)
