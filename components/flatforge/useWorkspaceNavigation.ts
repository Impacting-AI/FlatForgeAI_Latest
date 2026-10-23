'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { parseWorkspaceRoute, type WorkspaceRoute } from './workflow-route';

export type Navigate = (path: string, options?: { replace?: boolean; afterSave?: boolean }) => boolean;
export type NavigationGuard = (next: WorkspaceRoute | null) => boolean;
const historyKey = 'flatforgeNavigationIndex';

/** URLs are authoritative; the index lets a cancelled Back/Forward restore its exact entry. */
export function useWorkspaceNavigation(initialPath: string) {
  const initialURL = usePathname() ?? initialPath;
  const [path, setPath] = useState(initialURL);
  const guard = useRef<NavigationGuard>(() => true);
  const current = useRef({ path: initialURL, index: 0 });
  const restoring = useRef(false);
  const registerGuard = useCallback((next: NavigationGuard) => {
    guard.current = next;
    return () => { if (guard.current === next) guard.current = () => true; };
  }, []);
  useEffect(() => {
    const index = Number.isInteger(history.state?.[historyKey]) ? history.state[historyKey] as number : 0;
    history.replaceState({ ...history.state, [historyKey]: index }, '', location.href);
    current.current = { path: location.pathname, index };
    const pop = (event: PopStateEvent) => {
      if (restoring.current) { restoring.current = false; return; }
      const next = location.pathname;
      const nextIndex = event.state?.[historyKey];
      if (!guard.current(parseWorkspaceRoute(next))) {
        if (Number.isInteger(nextIndex) && nextIndex !== current.current.index) {
          restoring.current = true;
          history.go(current.current.index - nextIndex);
        } else history.replaceState({ ...history.state, [historyKey]: current.current.index }, '', current.current.path);
        return;
      }
      current.current = { path: next, index: Number.isInteger(nextIndex) ? nextIndex : 0 };
      setPath(next);
    };
    const unload = (event: BeforeUnloadEvent) => {
      // null means leaving/reloading the application; the guard reports dirty state only.
      if (!guard.current(null)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('popstate', pop);
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('beforeunload', unload); };
  }, []);
  const navigate: Navigate = useCallback((next, options = {}) => {
    if (restoring.current) return false;
    if (next === current.current.path) return true;
    if (!options.afterSave && !guard.current(parseWorkspaceRoute(next))) return false;
    const index = current.current.index + (options.replace ? 0 : 1);
    history[options.replace ? 'replaceState' : 'pushState']({ ...history.state, [historyKey]: index }, '', next);
    current.current = { path: next, index };
    setPath(next);
    return true;
  }, []);
  return { route: parseWorkspaceRoute(path), navigate, registerGuard };
}
