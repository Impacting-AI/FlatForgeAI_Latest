"""Apply measured review inputs to an exact supplied DXF; never infer by name."""
import argparse
import hashlib
import json
from pathlib import Path

from flatforge.engine import run


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--panel',required=True)
    parser.add_argument('--review-file',required=True,type=Path)
    parser.add_argument('--source',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args()
    panels=json.loads(args.review_file.read_text())['panels']
    if args.panel not in panels:parser.error('Panel key is not present in the supplied private review data.')
    data=panels[args.panel]
    if hashlib.sha256(args.source.read_bytes()).hexdigest()!=data['source_sha256']:
        parser.error('Source hash differs from the measured drawing. Review its geometry and values instead of applying this schedule.')
    result=run({'source':str(args.source),'output':str(args.output),
                'settings':data['settings'],'overrides':data['overrides']})
    print(result['status'])
    for issue in result.get('issues',[]):print(issue['code']+': '+issue['message'])
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':
    raise SystemExit(main())
