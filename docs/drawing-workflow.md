# Project drawings and drawing-specific processing

Previously, project selection and drawing selection lived only in component
state. STEP 1 doubled as project drawing management, Steps 2 and 4 iterated over
the project's panels, and refresh could fall back to the first panel. Selection
for a log/edit dialog also changed the active drawing.

The workspace now resolves both project and drawing IDs from the URL, verifies
their relationship against bootstrap data, and rejects missing or mismatched
IDs without selecting another drawing.

| URL | Scope |
| --- | --- |
| `/` | Projects |
| `/projects/:projectId/drawings` | Project drawing management |
| `/projects/:projectId/drawings/:drawingId/step/1` | Selected source, status, download and replacement |
| `/projects/:projectId/drawings/:drawingId/step/2` | Selected conversion and processing results |
| `/projects/:projectId/drawings/:drawingId/step/3` | Selected extraction and bend review |
| `/projects/:projectId/drawings/:drawingId/step/4` | Selected calculations and measurement |
| `/projects/:projectId/drawings/:drawingId/step/5` | Selected 3D model, validation and exports |
| `/projects/:projectId/compare` | Existing project-wide comparison |
| `/projects/:projectId/assembly` | Existing STEP 6 multi-panel assembly |

Project Drawings reuses the existing upload/drop zone, drawing cards, status,
logs, rename/replace/delete actions and project ZIP. Clicking a drawing opens
its source step. Existing DXF/DWG capabilities are unchanged; PDF support is not
introduced. A valid source never requires an additional upload.

## State and navigation

`workflow-route.ts` owns URL parsing, generation and context resolution.
`useWorkspaceNavigation.ts` owns native history and navigation guards. Real
dynamic routes support direct requests and refresh. The shared root layout
owns the client workspace so framework Back/Forward RSC updates cannot remount
and discard a review draft. Drawing workspace keys remain the same across its
five steps and change when selecting another drawing or a project-level view.

`useDrawingReview.ts` retains the existing review schema, value-source rules,
hidden relief decisions, validation and engineering settings. Polling hydrates
clean state but never overwrites dirty review edits. A changed revision/status
while editing shows a conflict and disables saving until the saved drawing is
reloaded; the draft's expected revision is not silently advanced. Changes made
during a pending save are not incorrectly marked saved.

Leaving a drawing with unsaved review changes asks whether to discard them.
Unapplied inline bend drafts, unsaved measurements and open management forms
also block accidental navigation. Refresh/close uses the browser's native
unsaved-changes prompt. Drafts are not server-saved automatically: use **Apply**
for an inline bend, then **Save & rebuild panel**. Saved work survives returning
to Project Drawings. Explicitly discarding a draft resets it on re-entry.

STEP 4 has one selected drawing row and an explicit **Save measurement** action.
Its value and axis are sent together, avoiding competing blur/change writes.
Project comparison and assembly still receive all eligible project panels;
assembly geometry, spacing, persistence and export implementations are unchanged.
Log-dialog targets are independent of workflow selection, and late log responses
from a closed/different dialog are ignored. Older bootstrap responses cannot
overwrite newer ones.

## API boundary and preserved data

`panelApi` supplies the exact panel ID and `x-flatforge-project-id` for drawing
review, measurement, management and log requests. The frontend API proxy forwards
that context. After existing shared-key authentication, the Python API rejects
a supplied project context that does not own the drawing before reading or
mutating it. Existing API clients without this optional header remain compatible;
this is a consistency check, not a new per-user permission system. Source and
artifact downloads retain the existing exact-panel URLs and authentication.

There are no database migrations or deletions of stored review/project data.
CAD extraction, bend calculations, conversion, STEP/STL generation and export
policies are unchanged. Restart the frontend and Python API after pulling;
existing panels do not need rebuilding for this navigation change.

## Verification commands

```sh
node --experimental-strip-types --test tests/*.test.mjs
pnpm exec tsc --noEmit
PYTHONPATH=backend OPENBLAS_NUM_THREADS=1 python -m pytest backend/tests/test_project_context.py backend/tests/test_workflow.py::test_upload_review_worker_exports_and_persistence backend/tests/test_bend_editor_workflow.py -q
node tests/drawing-workflow.browser.mjs
node tests/step3-review.browser.mjs
node tests/assembly.browser.mjs
pnpm build
```

Browser suites require Playwright and Chromium. Set `PLAYWRIGHT_MODULE` and
`FLATFORGE_CHROMIUM` for external installations, and `FLATFORGE_QA_OUTPUT` for
screenshots and exported GLBs. Run browser suites sequentially because their
development servers share framework caches. UI tests mock API transport;
Python tests exercise the real API, worker, CAD rebuild and STEP re-import.

Navigation coverage includes three different drawings and another project,
single-drawing Steps 1–5, scoped writes, refresh/direct links/Back/Forward,
discard/cancel and unload guards, pending-save edits, delayed logs, polling
conflicts, drawing and project CRUD, project-level multi-panel views, and mobile.
The existing STEP 3 suite covers 53 geometry-linked bend mappings, missing values,
inline edits, saved overrides and hidden relief preservation. Assembly tests
measure exported model coordinates and verify multi-panel spacing/persistence.

Executed for this change: **33 Node tests passed**, **4 selected API/CAD tests
passed with no skips**, all three browser suites passed, TypeScript passed,
focused lint on the new routing/state/measurement components and touched route
files passed, and `pnpm build` completed with the dynamic project route included.
Desktop and mobile screenshots were inspected. The existing `FlatForge.tsx`
lint findings remain (3 errors / 5 warnings, down from the original 7 / 10);
whole-project lint is not claimed to pass. Build output retains the existing
large-bundle warning and Vinext's route-classification notice.
