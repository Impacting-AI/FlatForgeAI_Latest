"""Reproducible CAD batch audit; customer drawings remain outside source control.

python -m flatforge.batch_audit INPUT_DIRECTORY OUTPUT_DIRECTORY
Every file receives its own engine artifacts. The summary preserves exceptions,
source hashes, unresolved evidence and validation results; it never changes
material settings or treats successful tessellation as manufacturing approval.
"""
import argparse
import contextlib
import hashlib
import json
import time
import traceback
from pathlib import Path
from .engine import run, dump


def audit(input_directory, output_directory, settings=None):
    source_root=Path(input_directory).resolve();output_root=Path(output_directory).resolve()
    if source_root==output_root or output_root.is_relative_to(source_root):
        raise ValueError('Keep audit outputs outside the input directory')
    files=sorted(p for p in source_root.rglob('*') if p.is_file() and p.suffix.lower() in ('.dxf','.dwg'))
    if not files:raise ValueError('No DXF or DWG files found')
    output_root.mkdir(parents=True,exist_ok=True)
    summary=[]
    for source in files:
        digest=hashlib.sha256(source.read_bytes()).hexdigest()
        relative=source.relative_to(source_root).as_posix()
        identifier=hashlib.sha256(relative.encode()).hexdigest()[:12]
        folder=output_root/identifier;folder.mkdir(exist_ok=True)
        # Reusing stale artifacts would make a failed rebuild look successful.
        if any(folder.iterdir()):raise ValueError(f'Audit output already exists: {folder}; choose a new output directory')
        row={'file':relative,'sha256':digest,'artifacts_directory':identifier};start=time.monotonic()
        with (folder/'conversion.log').open('w') as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            try:
                report=run({'source':str(source),'output':str(folder),'settings':settings or {}})
                row.update(status=report['status'],issues=report.get('issues',[]),faces=report.get('faces'),hinges=report.get('physical_bends'),
                           unresolved_bends=report.get('unresolved_bends',[]),section_mapping=report.get('section_mapping',[]),
                           section_checks=report.get('section_checks',[]),solid=report.get('solid'),unfold_check=report.get('unfold_check'))
            except Exception as error:
                traceback.print_exc()
                row.update(status='FAILED',error=f'{type(error).__name__}: {error}',diagnostic=getattr(error,'diagnostics',None))
        row['elapsed_seconds']=round(time.monotonic()-start,3)
        summary.append(row);dump(output_root/'summary.json',summary)
        print(f"{relative}: {row['status']}",flush=True)
    return summary


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input_directory');parser.add_argument('output_directory')
    parser.add_argument('--settings',type=Path,help='JSON containing explicit panel material settings')
    args=parser.parse_args()
    rows=audit(args.input_directory,args.output_directory,json.loads(args.settings.read_text()) if args.settings else None)
    return 0 if all(r['status']=='PASS' for r in rows) else 1


if __name__=='__main__':raise SystemExit(main())
