'use client';
import { useCallback, useSyncExternalStore, type SetStateAction } from 'react';
import type { AssemblyEntry } from './types';
import { ASSEMBLY_STORAGE_KEY, decodeAssemblies, encodeAssemblies, type AssemblyProjects } from './assembly-storage';

type Snapshot = { projects: AssemblyProjects; error: string; writable: boolean };
const server: Snapshot = { projects: {}, error: '', writable: false };
const empty: AssemblyEntry[] = [];
let cached: Snapshot | null = null;
const listeners = new Set<() => void>();
function read(): Snapshot {
  try { return { projects: decodeAssemblies(localStorage.getItem(ASSEMBLY_STORAGE_KEY)), error: '', writable: true }; }
  catch { return { projects: {}, error: 'Saved assembly could not be read. Existing storage is preserved; changes are session-only.', writable: false }; }
}
const snapshot = () => cached ?? (cached = read());
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === ASSEMBLY_STORAGE_KEY || event.key === null) { cached = read(); listeners.forEach(notify => notify()); }
  };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

/** Browser-local layouts, isolated by project; corrupt/unknown storage is never overwritten. */
export function useAssemblyState(projectId: string) {
  const state = useSyncExternalStore(subscribe, snapshot, () => server);
  const update = useCallback((action: SetStateAction<AssemblyEntry[]>) => {
    if (!projectId) return;
    const previous = snapshot();
    const entries = previous.projects[projectId] ?? empty;
    const projects = { ...previous.projects, [projectId]: typeof action === 'function' ? action(entries) : action };
    cached = { ...previous, projects };
    if (previous.writable) {
      try { localStorage.setItem(ASSEMBLY_STORAGE_KEY, encodeAssemblies(projects)); cached.error = ''; }
      catch { cached.error = 'Assembly could not be saved in this browser. Changes are session-only.'; }
    }
    listeners.forEach(notify => notify());
  }, [projectId]);
  return [state.projects[projectId] ?? empty, update, state.error] as const;
}
