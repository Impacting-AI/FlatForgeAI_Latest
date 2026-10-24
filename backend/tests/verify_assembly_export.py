"""Verify a browser-downloaded STEP against its exported preview matrices."""
import json
import sys
from pathlib import Path
import cadquery as cq
from flatforge.assembly import bounds, location, read_solid
from flatforge.db import Session, Panel

path, manifest = map(Path, sys.argv[1:])
entries = json.loads(manifest.read_text())
assembly = cq.importers.importStep(str(path)).val()
assert assembly.isValid()
remaining = assembly.Solids()
expected_count = 0
with Session() as session:
    for entry in entries:
        panel = session.get(Panel, entry['panelId'])
        assert panel.revision == entry['revision']
        source, _ = read_solid(json.loads(panel.artifacts)['panel.step'])
        for solid in source.moved(location(entry['matrix'])).Solids():
            expected_count += 1
            box = bounds(solid)
            found = next((index for index, candidate in enumerate(remaining) if
                          max(abs(x-y) for side in ('min','max') for x,y in zip(bounds(candidate)[side], box[side])) < 1e-5
                          and abs(candidate.Volume()-solid.Volume()) < max(1e-5,solid.Volume()*1e-7)), None)
            assert found is not None, f'Missing or incorrectly placed solid in {entry["id"]}'
            actual = remaining.pop(found)
            assert sorted(face.geomType() for face in actual.Faces()) == sorted(face.geomType() for face in solid.Faces())
assert expected_count == len(assembly.Solids()) and not remaining
print(f'CAD PASS: {expected_count} valid solids, preserved face geometry, volumes and exact preview matrices')
