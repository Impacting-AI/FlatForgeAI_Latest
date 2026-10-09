"""Source-linked mapping diagnostics; these never select a bend or build a solid."""


def candidate_summary(candidate):
    return {'faces':candidate['chain'],'root_face':candidate.get('root_face'),
            'scope':candidate.get('scope','local_edge_profile'),'max_strip_error_mm':candidate['error'],
            'hinges':[{'hinge':e['index'],'source_handles':[s['handle'] for s in e.get('source',[])],
                       'signed_rotation_deg':float(a),'vertex':i+1}
                      for i,(e,a) in enumerate(zip(candidate['hinges'],candidate['angles']))]}


def explain_mapping(profile,row,local_choices):
    """Distinguish missing correspondence, projection, sign and length evidence."""
    if row['status']=='PASS':return
    row['local_candidate_count']=len({c['signature'] for c in local_choices})
    unique={c['signature']:c for c in local_choices}
    row['local_candidates']=[candidate_summary(unique[k]) for k in sorted(unique)[:24]]
    row['local_candidates_truncated']=len(unique)>24
    missing=[]
    blocking={'SECTION_CONFLICT','LOCAL_SECTION_CONFLICT','SOURCE_AXIS_CONFLICT','ANGLE_EVIDENCE_CONFLICT','SEARCH_LIMIT'}
    if unique and row.get('reason_code') not in blocking:
        row['normal_mapping_diagnostic']={'reason_code':row.get('reason_code'),'reason':row.get('reason')}
        row['reason_code']='AMBIGUOUS_LOCAL_CHAIN' if len(unique)>1 else 'LOCAL_ANCHOR_MISSING'
        row['reason']='Multiple local hinge chains fit; independent source evidence does not distinguish them.' if len(unique)>1 else 'One local chain fits, but its interpretation lacks an independent orientation anchor.'
    if unique:
        if len(unique)>1:
            missing.append({'kind':'section_correspondence',
                'required':'A section cut/edge reference identifying which of the listed hinge chains this profile describes.'})
        else:
            missing.append({'kind':'independent_orientation_anchor',
                'required':'An independently mapped painted section sharing a hinge, or an independently painted corroborating local profile.'})
    projected=row.get('nearest_projected_candidate')
    if projected:
        row['projected_evidence']={**projected,'role':'diagnostic candidate, not an accepted correspondence','angle_role':'apparent profile turns; not physical hinge rotations',
            'missing_evidence':['View direction or section plane linked to the drawing',
                                'Unique correspondence from projected vertices to physical hinges',
                                'Independent true-angle or additional-view constraints where projection is ambiguous']}
        if not unique and not row.get('supported_candidate_chains'):
            missing.append({'kind':'projection_definition','required':'Establish the view/section plane and hinge correspondence before converting apparent turns into true bend rotations.'})
    if row.get('reason_code')=='STRIP_LENGTH_MISMATCH':
        missing.append({'kind':'dimensional_agreement',
            'required':'Reconcile the listed strip residuals with the source dimensions and panel parameters; a nearer residual alone is not proof.'})
    if row.get('reason_code') in ('SECTION_CONFLICT','LOCAL_SECTION_CONFLICT','SOURCE_AXIS_CONFLICT','ANGLE_EVIDENCE_CONFLICT'):
        missing=[{'kind':'contradictory_evidence','required':'Resolve the conflicting source profiles and signed rotations recorded in the constraint diagnostics.'}]
    if row.get('reason_code')=='SEARCH_LIMIT':
        missing=[{'kind':'search_incomplete','required':'A section cut or edge reference to narrow the candidate component; a truncated search cannot establish uniqueness.'}]
    if not missing:
        missing.append({'kind':'complete_chain','required':'A section showing the missing segments/terminal return, or a linked local detail identifying its parent face.'})
    row['missing_evidence']=missing


def explain_unmapped_hinges(edges,profiles,rows):
    """A mapped profile is not proof that all terminal bends were documented."""
    result=[]
    for edge in edges:
        if 'angle' in edge:continue
        candidates=[]
        for profile,row in zip(profiles,rows):
            choices=profile.get('_normal_candidates',[])+profile.get('_local_candidates',[])
            for c in choices:
                if any(e['index']==edge['index'] for e in c['hinges']):
                    candidates.append(profile['name']);break
        result.append({'hinge':edge['index'],'parent':edge['parent'],'child':edge['child'],
            'source_handles':[s['handle'] for s in edge['source']],
            'candidate_profiles':sorted(set(candidates)),
            'reason':'Conflicting source evidence.' if edge.get('evidence_conflict') else
                     'Candidate profiles exist, but correspondence or independent orientation is unresolved.' if candidates else
                     'No supported section candidate covers this hinge; a neighbouring bend angle cannot be copied.',
            'missing_evidence':'A linked painted section/detail establishing this hinge’s true angle and direction, or an explicit operator correction.'})
    return result


def bend_traceability(faces,edges,profiles,rows):
    """Audit every physical hinge independently of whether a solid can be built.

    Operator choices are a separate evidence class, never labelled drawing
    recovery. A signed angle alone is not a resolved drawing interpretation.
    """
    import math
    from . import geometry as g
    from .bend_rules import direction_factor
    result=[]
    manual_names={'USER CONFIRMED','USER DIRECTION','PANEL ANGLE'}
    for edge in edges:
        angle=edge.get('angle');evidence=edge.get('evidence',[])
        manual=any(ev.get('profile') in manual_names for ev in evidence)
        drawing=[ev for ev in evidence if ev.get('profile') not in manual_names]
        complete=[ev for ev in drawing if ev.get('profile') and isinstance(ev.get('vertex'),int)
                  and ev['vertex']>0 and ev.get('handles_before') and ev.get('handles_after') and ev.get('paint_marker')
                  and isinstance(ev.get('angle'),(int,float)) and angle is not None and math.isclose(ev['angle'],angle,abs_tol=1e-5,rel_tol=0)]
        parent,child=edge.get('parent'),edge.get('child')
        topology=isinstance(parent,int) and isinstance(child,int) and 0<=parent<len(faces) and 0<=child<len(faces) and parent!=child
        valid_angle=angle is not None and math.isfinite(angle) and 0<abs(angle)<180
        reasons=[];warnings=[];direction=None
        if not topology:reasons.append({'code':'PARENT_RELATION_MISSING','message':'Parent/child face relationship is not established.'})
        if valid_angle and topology:
            try:direction='up' if angle*direction_factor(edge,faces)>0 else 'down'
            except ValueError:reasons.append({'code':'DIRECTION_FRAME_MISSING','message':'Child-side orientation cannot be established for this hinge.'})
        if not valid_angle:
            for profile,row in zip(profiles,rows):
                candidates=profile.get('_normal_candidates',[])+profile.get('_local_candidates',[])
                supported=any(any(e['index']==edge['index'] for e in c['hinges']) for c in candidates)
                diagnostic=any(edge['index'] in row.get(key,{}).get('hinges',[]) for key in
                               ('nearest_candidate','nearest_normal_candidate','nearest_projected_candidate') if row.get(key))
                if (supported or diagnostic) and row.get('status')!='PASS':
                    reasons.append({'code':row.get('reason_code','SECTION_MAPPING_UNRESOLVED'),'profile':profile['name'],
                                    'source_handles':row.get('source_handles',[]),'message':row.get('reason'),
                                    'candidate_role':'supported hypothesis' if supported else 'diagnostic only',
                                    'missing_evidence':row.get('missing_evidence',[])})
            if not reasons:reasons.append({'code':'NO_SECTION_COVERAGE','message':'No accepted section assigns this hinge; a linked painted detail must establish its angle and direction.'})
        if edge.get('evidence_conflict') or any(a.get('status')=='CONFLICT' for a in edge.get('drawing_dimensions',[])):
            (warnings if manual else reasons).append({'code':'DRAWING_EVIDENCE_CONFLICT','message':'Source-axis or angular-dimension evidence conflicts; inspect the retained sources.'})
        disagreeing=[ev for ev in drawing if valid_angle and isinstance(ev.get('angle'),(int,float))
                     and not math.isclose(ev['angle'],angle,abs_tol=1e-5,rel_tol=0)]
        if disagreeing:
            (warnings if manual else reasons).append({'code':'CONFLICTING_ASSIGNED_SOURCES',
                'message':'Retained drawing sources disagree with the assigned signed rotation.',
                'sources':disagreeing})
        if valid_angle and not manual and not complete:
            reasons.append({'code':'DRAWING_PROVENANCE_INCOMPLETE','message':'Assigned angle has no complete matching section record: angle, vertex, adjoining wall handles and paint marker.'})
        if not edge.get('source') or any(not s.get('handle') for s in edge.get('source',[])):
            reasons.append({'code':'HINGE_SOURCE_MISSING','message':'Original KIFOF source handle is missing.'})
        status='NEEDS_REVIEW' if reasons else 'OPERATOR_OVERRIDE' if manual else 'RESOLVED_FROM_DRAWING'
        u,n,c=g.support(edge)
        result.append({'hinge':edge['index'],'key':edge.get('review_key'),'bend_ids':[s.get('id') for s in edge.get('source',[])],
            'kifof_handles':[s.get('handle') for s in edge.get('source',[])],'parent':parent,'child':child,
            'signed_rotation_deg':float(angle) if valid_angle else None,
            'included_angle_deg':180-abs(float(angle)) if valid_angle else None,
            'direction':direction,'direction_frame':'parent-local; relative to the child side and recorded hinge axis',
            'axis_direction':u.tolist(),'axis_normal':n.tolist(),'axis_offset_mm':float(c),
            'status':status,'drawing_sources':drawing,'operator_sources':[ev for ev in evidence if ev.get('profile') in manual_names],
            'original_drawing_sources':edge.get('source_evidence',[]),'reasons':reasons,'warnings':warnings})
    return result
