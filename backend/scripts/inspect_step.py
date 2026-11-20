"""Report basic topology and self-interference separately for a STEP file."""
import argparse
import collections
import hashlib
import json
from pathlib import Path

import cadquery as cq
from OCP.BRepAlgoAPI import BRepAlgoAPI_Check


def inspect(path):
    shape=cq.importers.importStep(str(path)).val()
    check=BRepAlgoAPI_Check(shape.wrapped,False,True)
    counts=collections.Counter(str(item.GetCheckStatus()).split('.')[-1] for item in check.Result())
    return {'filename':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'basic_brep_valid':shape.isValid(),'solid_count':len(shape.Solids()),
            'face_count':len(shape.Faces()),'self_interference_pass':check.IsValid(),
            'interference_records':dict(counts),
            'method':'OpenCascade BRepAlgoAPI_Check; small-edge test disabled; records are not counts of distinct physical defects.'}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('step',type=Path)
    print(json.dumps(inspect(parser.parse_args().step),indent=2))
