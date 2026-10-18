"""Independent deterministic re-audit of corrected copies; no AI or database writes."""
from collections import Counter

from app.services.document_parser import extract_paragraphs, parse_document
from app.services.layout_engine import run_static_rules_engine
from app.services.profile_preset_adapter import EffectiveProfileConfig
from app.services.profile_snapshot import snapshot_from_dict
from app.services.scoring import calculate_weighted_score_detailed
from app.services.guided_fix import GuidedFixFailed


def _positions(finding):
    loc = finding.location if isinstance(finding.location, dict) else {}
    paragraphs = loc.get('paragraph_indexes')
    if isinstance(paragraphs, list):
        if (any(type(i) is not int or i < 0 for i in paragraphs) or
                loc.get('occurrences') != len(set(paragraphs))):
            raise GuidedFixFailed('incomplete finding locations')
    else:
        paragraphs = [loc.get('paragraph_index')]
        if loc.get('occurrences', 1) != 1:
            raise GuidedFixFailed('incomplete finding locations')
    runs = loc.get('run_indexes', [loc.get('run_index')])
    if not isinstance(runs, list) or not runs:
        raise GuidedFixFailed('incomplete run locations')
    if any(i is not None and (type(i) is not int or i < 0) for i in runs):
        raise GuidedFixFailed('invalid run location')
    return [(p, r, loc.get('section_index')) for p in paragraphs for r in runs]


def _evidence(findings):
    evidence = Counter()
    for f in findings:
        for position in _positions(f):
            evidence[(f.rule_code, f.severity, position, f.expected_value, f.actual_value)] += 1
    return evidence


def _summary(findings):
    return [{ 'rule_code': f.rule_code, 'count': len(_positions(f)),
              'locations': [f'Paragraph {p + 1}' if type(p) is int else 'Document'
                            for p, _, _ in _positions(f)]}
            for f in findings]


def verify_reaudit(audit, source_bytes: bytes, fixed_bytes: bytes, selected):
    """Require a fresh source baseline and disappearance without new regressions."""
    try:
        snapshot = snapshot_from_dict(audit.profile_snapshot)
        config = EffectiveProfileConfig(snapshot)
        source_mapping = audit.paragraph_page_mapping if isinstance(audit.paragraph_page_mapping, dict) else None
        before = run_static_rules_engine(source_bytes, config=config, page_mapping=source_mapping)
        if _evidence(before) != _evidence(audit.violations):
            raise GuidedFixFailed('persisted audit differs from current deterministic baseline')
        before_score = calculate_weighted_score_detailed(before)
        if audit.weighted_score != before_score.total:
            raise GuidedFixFailed('persisted score differs from baseline')
        from app.services.reference_section import (
            find_reference_heading_index, classify_reference_page_start,
            PAGE_START_UNAVAILABLE, PAGE_START_UNCERTAIN,
        )
        source_doc = parse_document(source_bytes)
        source_paragraphs = extract_paragraphs(source_doc)
        heading = find_reference_heading_index(source_paragraphs)
        needs_page_evidence = bool(config.REFERENCES_CHECK_START_ON_NEW_PAGE and heading is not None)
        fixed_mapping = None
        if source_mapping is not None or needs_page_evidence:
            from app.services.docx_pdf_converter import convert_docx_to_pdf
            from app.services.page_mapping import compute_paragraph_page_mapping
            if source_mapping is None:
                source_pdf = convert_docx_to_pdf(source_bytes)
                source_mapping = compute_paragraph_page_mapping(source_paragraphs, source_pdf)
                if source_mapping is None:
                    raise GuidedFixFailed('rendered source evidence unavailable')
                mapped_before = run_static_rules_engine(source_bytes, config=config, page_mapping=source_mapping)
                if _evidence(mapped_before) != _evidence(before):
                    raise GuidedFixFailed('source page evidence differs from stored audit')
            fixed_doc = parse_document(fixed_bytes)
            fixed_paragraphs = extract_paragraphs(fixed_doc)
            fixed_pdf = convert_docx_to_pdf(fixed_bytes)
            fixed_mapping = compute_paragraph_page_mapping(fixed_paragraphs, fixed_pdf)
            if fixed_mapping is None:
                raise GuidedFixFailed('fixed document cannot be page-mapped')
            if needs_page_evidence:
                for paragraphs, document, mapping in (
                    (source_paragraphs, source_doc, source_mapping),
                    (fixed_paragraphs, fixed_doc, fixed_mapping),
                ):
                    evidence = classify_reference_page_start(
                        paragraphs, heading, page_mapping=mapping,
                        paragraph_objs=dict(enumerate(document.paragraphs)),
                    )
                    if evidence.state in (PAGE_START_UNAVAILABLE, PAGE_START_UNCERTAIN):
                        raise GuidedFixFailed('reference page evidence unresolved')
        after = run_static_rules_engine(fixed_bytes, config=config, page_mapping=fixed_mapping)
        before_ev, after_ev = _evidence(before), _evidence(after)
        selected_positions = set()
        for f in selected:
            for position in _positions(f):
                selected_positions.add((f.rule_code, position))
        if any((f.rule_code, position) in selected_positions
               for f in after for position in _positions(f)):
            raise GuidedFixFailed('a selected finding remains after re-audit')
        for (code, severity, position, expected, actual), count in after_ev.items():
            if count > before_ev[(code, severity, position, expected, actual)]:
                raise GuidedFixFailed('new or worsened finding after re-audit')
        after_score = calculate_weighted_score_detailed(after)
        before_deductions = {r.category: r.deduction for r in before_score.breakdown}
        if any(r.deduction > before_deductions.get(r.category, 0) for r in after_score.breakdown):
            raise GuidedFixFailed('category deduction increased')
        return {
            'before_score': before_score.total, 'after_score': after_score.total,
            'before_findings': _summary(before), 'after_findings': _summary(after),
            'new_findings': [],
        }
    except GuidedFixFailed:
        raise
    except Exception as exc:
        raise GuidedFixFailed('deterministic re-audit unavailable') from exc
