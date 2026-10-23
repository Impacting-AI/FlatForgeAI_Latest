import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseWorkspaceRoute, projectDrawingsPath, drawingPath, projectViewPath, workspaceKey, resolveWorkspace, drawingSteps } from '../components/flatforge/workflow-route.ts';
import { panelApi } from '../components/flatforge/types.ts';

const data = JSON.parse(fs.readFileSync(new URL('../lib/sample-data.json', import.meta.url)));
const project = data.projects[0], drawing = data.panels[1];

test('dedicated project, drawing and assembly URLs round trip IDs and all steps', () => {
  assert.deepEqual(parseWorkspaceRoute('/'), { kind: 'home' });
  assert.deepEqual(parseWorkspaceRoute(projectDrawingsPath(project.id)), { kind: 'drawings', projectId: project.id });
  for (const step of drawingSteps) assert.deepEqual(parseWorkspaceRoute(drawingPath(project.id, drawing.id, step)),
    { kind: 'drawing', projectId: project.id, drawingId: drawing.id, step });
  for (const kind of ['assembly', 'compare']) assert.deepEqual(parseWorkspaceRoute(projectViewPath(project.id, kind)), { kind, projectId: project.id });
  assert.deepEqual(parseWorkspaceRoute(drawingPath('client project', 'drawing #2', 'calculate')), { kind: 'drawing', projectId: 'client project', drawingId: 'drawing #2', step: 'calculate' });
});

test('malformed, unsupported and incomplete URLs never default to a drawing', () => {
  for (const path of ['/projects', '/projects/x', '/projects/x/drawings/y', '/projects/x/drawings/y/step/0', '/projects/x/drawings/y/step/6', '/projects/x/drawings/y/step/03', '/projects/x/drawings/y/step/4/extra', '/projects/%FF/drawings', '/projects/x/drawings/..%2fy/step/1']) {
    assert.equal(parseWorkspaceRoute(path).kind, 'invalid', path);
  }
});

test('drawing scope selects exactly the URL drawing; project scope has no implicit panel', () => {
  const scope = resolveWorkspace(data, parseWorkspaceRoute(drawingPath(project.id, drawing.id, 'calculate')));
  assert.equal(scope.valid, true); assert.equal(scope.panel.id, drawing.id);
  assert.equal(resolveWorkspace(data, parseWorkspaceRoute(projectDrawingsPath(project.id))).panel, undefined);
  const missing = resolveWorkspace(data, parseWorkspaceRoute(drawingPath(project.id, 'deleted')));
  assert.equal(missing.valid, false); assert.equal(missing.panel, undefined);
});

test('a drawing from another project is rejected even if its ID exists in bootstrap', () => {
  const other = { ...project, id: 'foreign-project' };
  const scoped = { ...data, projects: [...data.projects, other] };
  assert.equal(resolveWorkspace(scoped, parseWorkspaceRoute(drawingPath(other.id, drawing.id))).valid, false);
  const assembly = resolveWorkspace(scoped, parseWorkspaceRoute(projectViewPath(project.id, 'assembly')));
  assert.equal(assembly.panels.length, data.panels.filter(p => p.project_id === project.id).length);
  assert.equal(assembly.panel, undefined);
});

test('draft context persists between steps but resets between drawings and project views', () => {
  assert.equal(workspaceKey(parseWorkspaceRoute(drawingPath(project.id, drawing.id, 'review'))), workspaceKey(parseWorkspaceRoute(drawingPath(project.id, drawing.id, 'calculate'))));
  assert.notEqual(workspaceKey(parseWorkspaceRoute(drawingPath(project.id, drawing.id))), workspaceKey(parseWorkspaceRoute(drawingPath(project.id, data.panels[0].id))));
  assert.notEqual(workspaceKey(parseWorkspaceRoute(projectDrawingsPath(project.id))), workspaceKey(parseWorkspaceRoute(projectViewPath(project.id, 'assembly'))));
});

test('panel requests carry both the exact panel ID and owning project context', async () => {
  const original = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return Response.json({ ok: true }); };
  try {
    await panelApi(drawing, '/measurement', { value: 123, axis: 'folded_x' }, 'PUT');
    assert.equal(request.url, `/api/engine/panels/${drawing.id}/measurement`);
    assert.equal(request.options.headers['x-flatforge-project-id'], project.id);
    assert.equal(request.options.method, 'PUT');
    assert.throws(() => panelApi(undefined, '/review', {}), /Select a drawing/);
  } finally { globalThis.fetch = original; }
});
