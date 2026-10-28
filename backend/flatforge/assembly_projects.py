"""One explicitly saved assembly per project, using existing SQLAlchemy storage.

Revision compare-and-swap prevents silent cross-tab/client overwrites. Saving
consumes the approved rigid placement token; it never reruns the mate solver.
"""
import json
import time
from fastapi import HTTPException
from pydantic import Field, model_validator
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from .db import Session, Project, ProjectAssembly
from . import assembly


class SavedEntry(assembly.Entry):
    label: str = Field(pattern=r'^[A-Z]+$', max_length=8)


class SaveInput(assembly.StrictModel):
    revision: int = Field(ge=0)
    entries: list[SavedEntry] = Field(max_length=100)
    token: str | None = Field(default=None, max_length=300000)

    @model_validator(mode='after')
    def unique_labels(self):
        if len({e.label for e in self.entries}) != len(self.entries):
            raise ValueError('Panel labels must be unique')
        if self.entries:
            assembly.AssemblyInput(entries=[assembly.Entry.model_validate(e.model_dump(exclude={'label'})) for e in self.entries], policy='free')
        return self


def project_exists(session, project_id):
    project = session.get(Project, project_id)
    if not project or project.deleted_at is not None:
        raise HTTPException(404, 'Project not found')


def document(project_id, saved):
    return {'id': project_id, 'projectId': project_id, 'revision': saved.revision if saved else 0,
            'units': 'mm', 'updated': saved.updated if saved else None,
            'entries': json.loads(saved.config)['entries'] if saved else []}


def load(project_id):
    with Session() as session:
        project_exists(session, project_id)
        return document(project_id, session.get(ProjectAssembly, project_id))


def save(project_id, body):
    with assembly.CAD_LOCK:
        if body.entries:
            if not body.token:
                raise HTTPException(422, 'Wait for the current assembly positions before saving')
            payload = assembly.unsign(body.token)
            if payload.get('version') != 1 or payload.get('project') != project_id or payload.get('policy') != 'free':
                raise HTTPException(422, 'This placement approval belongs to a different assembly or workflow')
            rows = [assembly.Entry.model_validate(e.model_dump(exclude={'label'})) for e in body.entries]
            assembly.AssemblyInput(entries=rows, policy='free')
            if [e.model_dump(mode='json') for e in rows] != payload.get('entries'):
                raise HTTPException(409, 'Assembly changed after its positions were checked. Wait for the latest preview and save again.')
            sources = assembly.load_sources(project_id, rows)
            if any(payload['sources'].get(key) != {'key': s['key'], 'sha256': s['sha256']} for key,s in sources.items()):
                raise HTTPException(409, 'A drawing changed before saving. Reload its current result.')
        # Keep source revision, connection provenance, pose, and exact final matrix.
        entries = []
        for e in body.entries:
            row = e.model_dump(exclude_none=True)
            row.update(targetId=e.targetId, targetFace=e.targetFace)
            entries.append(row)
        config = json.dumps({'version': 1, 'units': 'mm', 'entries': entries}, allow_nan=False, sort_keys=True)
        try:
            with Session.begin() as session:
                project_exists(session, project_id)
                current = session.get(ProjectAssembly, project_id)
                if (current.revision if current else 0) != body.revision:
                    raise HTTPException(409, 'This project assembly was saved elsewhere. Reload the saved assembly before replacing it; your current edits have been retained.')
                if current and current.config == config:
                    return document(project_id, current)
                now = time.time()
                if current:
                    changed = session.execute(update(ProjectAssembly).where(ProjectAssembly.project_id == project_id, ProjectAssembly.revision == body.revision).values(config=config, revision=body.revision+1, updated=now))
                    if changed.rowcount != 1:
                        raise HTTPException(409, 'Another save completed first. Reload the saved assembly; current edits are retained.')
                    session.refresh(current)
                else:
                    current = ProjectAssembly(project_id=project_id, revision=1, config=config, updated=now)
                    session.add(current); session.flush()
                return document(project_id, current)
        except IntegrityError as error:
            raise HTTPException(409, 'Another save completed first. Reload the saved assembly; current edits are retained.') from error
