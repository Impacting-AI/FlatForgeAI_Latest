import type { Bootstrap } from './types';

export const drawingSteps = ['panels', 'conversion', 'review', 'calculate', 'viewer'] as const;
export type DrawingStep = typeof drawingSteps[number];
export type WorkspaceRoute =
  | { kind: 'home' | 'invalid' }
  | { kind: 'drawings' | 'assembly' | 'compare'; projectId: string }
  | { kind: 'drawing'; projectId: string; drawingId: string; step: DrawingStep };

export function parseWorkspaceRoute(path: string): WorkspaceRoute {
  if (path === '/') return { kind: 'home' };
  try {
    const parts = path.replace(/\/$/, '').split('/').slice(1).map(decodeURIComponent);
    if (parts[0] !== 'projects' || !parts[1] || parts.some(part => part.includes('/') || part.includes('\\') || part === '..')) return { kind: 'invalid' };
    const projectId = parts[1];
    if (parts.length === 3 && ['drawings', 'assembly', 'compare'].includes(parts[2])) return { kind: parts[2] as 'drawings' | 'assembly' | 'compare', projectId };
    if (parts.length === 6 && parts[2] === 'drawings' && parts[3] && parts[4] === 'step' && /^[1-5]$/.test(parts[5])) {
      return { kind: 'drawing', projectId, drawingId: parts[3], step: drawingSteps[Number(parts[5]) - 1] };
    }
  } catch { /* Malformed encoded identifiers must never select another drawing. */ }
  return { kind: 'invalid' };
}
export const projectDrawingsPath = (id: string) => `/projects/${encodeURIComponent(id)}/drawings`;
export const drawingPath = (projectId: string, drawingId: string, step: DrawingStep = 'panels') =>
  `${projectDrawingsPath(projectId)}/${encodeURIComponent(drawingId)}/step/${drawingSteps.indexOf(step) + 1}`;
export const projectViewPath = (id: string, view: 'assembly' | 'compare') => `/projects/${encodeURIComponent(id)}/${view}`;
export function workspaceKey(route: WorkspaceRoute) {
  return route.kind === 'drawing' ? `${route.projectId}/drawing/${route.drawingId}`
    : 'projectId' in route ? `${route.projectId}/${route.kind}` : route.kind;
}
/** Resolve both IDs against the authorized bootstrap. Never fall back to another panel. */
export function resolveWorkspace(data: Bootstrap, route: WorkspaceRoute) {
  const project = 'projectId' in route ? data.projects.find(project => project.id === route.projectId) : undefined;
  const panels = project ? data.panels.filter(panel => panel.project_id === project.id) : [];
  const panel = route.kind === 'drawing' ? panels.find(panel => panel.id === route.drawingId) : undefined;
  const valid = route.kind === 'home' || (route.kind !== 'invalid' && !!project && (route.kind !== 'drawing' || !!panel));
  return { project, panels, panel, valid };
}
