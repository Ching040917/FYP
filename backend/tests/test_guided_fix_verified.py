"""The correction is downloadable only after independent verification."""
import hashlib
import io
import json
import copy
import zipfile
from dataclasses import replace

from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn

import pytest
from sqlalchemy.orm import Session
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement

from app.models.audit import AuditRecord, Violation
from app.services.guided_fix import GuidedFixFailed, review_targets
from types import SimpleNamespace
from app.services.guided_fix_verification import verify_reaudit
from app.services.layout_engine import run_static_rules_engine
from app.services.profile_preset_adapter import EffectiveProfileConfig
from app.services.profile_schema import new_custom_profile
from app.services.profile_snapshot import resolve_snapshot
from app.services.scoring import calculate_weighted_score_detailed
from app.services import guided_fix_storage
from tests.test_guided_fix_reference_heading import (
    BOLD_RULE, _bold_audit, _bold_bytes, _bold_doc,
)


def _doc():
    doc = Document()
    p = doc.add_paragraph('Body paragraph.')
    p.runs[0].font.size = Pt(11)
    p.runs[0].font.name = 'Times New Roman'
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _upload(client, path, data, ids, review_id=None):
    fields = {'selection': json.dumps({'violation_ids': ids})}
    if review_id is not None:
        fields['review_id'] = review_id
    return client.post(path, data=fields, files={'file': ('original.docx', data)})


def test_review_apply_download_once(client, monkeypatch, tmp_path):
    monkeypatch.setattr(guided_fix_storage.settings, 'GUIDED_FIX_STORAGE_DIR', str(tmp_path))
    source = _doc()
    audit = client.post('/api/audit', files={'file': ('original.docx', source)})
    assert audit.status_code == 200, audit.text
    audit_id = audit.json()['audit_id']
    ids = [v['id'] for v in audit.json()['physical_layout_errors'] if v['rule_code'] == 'FONT_SIZE']
    assert ids
    root = f'/api/audit/{audit_id}/guided-fixes'
    assert _upload(client, root, source, ids).status_code == 422
    review = _upload(client, root + '/review', source, ids)
    assert review.status_code == 200, review.text
    assert review.json()['items'][0]['locations'] == ['Paragraph 1']
    applied = _upload(client, root, source, ids, review.json()['review_id'])
    assert applied.status_code == 200, applied.text
    payload = applied.json()
    assert payload['status'] == 'passed'
    assert payload['resolved'] == ids[:1]
    assert payload['new_findings'] == []
    assert _upload(client, root, source, ids, review.json()['review_id']).status_code == 409
    download = client.get(root + '/download/' + payload['download_token'])
    assert download.status_code == 200
    assert download.headers['cache-control'] == 'private, no-store'
    assert Document(io.BytesIO(download.content)).paragraphs[0].runs[0].font.size.pt == 12
    assert client.get(root + '/download/' + payload['download_token']).status_code == 410
    assert hashlib.sha256(source).digest() != hashlib.sha256(download.content).digest()
    assert audit.json()['weighted_compliance_score'] == client.get(f'/api/audit/{audit_id}').json()['weighted_score']


def test_cancel_review_prevents_apply(client):
    source = _doc()
    audit = client.post('/api/audit', files={'file': ('original.docx', source)})
    audit_id = audit.json()['audit_id']
    ids = [v['id'] for v in audit.json()['physical_layout_errors'] if v['rule_code'] == 'FONT_SIZE']
    root = f'/api/audit/{audit_id}/guided-fixes'
    review = _upload(client, root + '/review', source, ids)
    assert review.status_code == 200, review.text
    token = review.json()['review_id']
    assert client.delete(root + '/review/' + token).status_code == 204
    assert client.delete(root + '/review/' + token).status_code == 204
    assert _upload(client, root, source, ids, token).status_code == 409

@pytest.mark.parametrize('rule', [
    'FONT_SIZE', 'FONT_CONSISTENCY', 'ALIGNMENT',
    'LINE_SPACING', 'SPACE_BEFORE', 'SPACE_AFTER',
])
def test_every_rule_rejects_missing_paragraph_target(rule):
    audit = AuditRecord(id='source', filename='original.docx', status='completed')
    finding = Violation(
        id='finding', audit_id='source', rule_code=rule, severity='MINOR',
        location={'paragraph_index': 19, **({'run_index': 0} if rule.startswith('FONT') else {})},
        message='m', actual_value='11pt', expected_value='12pt',
    )
    with pytest.raises(GuidedFixFailed):
        review_targets(audit, _doc(), [finding])


@pytest.mark.parametrize('run_indexes', [[0, 1], [0, 0], [True], []])
def test_run_group_requires_complete_distinct_indexes(run_indexes):
    audit = AuditRecord(id='source', filename='original.docx', status='completed')
    finding = Violation(
        id='finding', audit_id='source', rule_code='FONT_SIZE', severity='MINOR',
        location={'paragraph_index': 0, 'run_indexes': run_indexes},
        message='m', actual_value='11pt', expected_value='12pt',
    )
    with pytest.raises(GuidedFixFailed):
        review_targets(audit, _doc(), [finding])

def test_reference_page_check_never_passes_without_rendered_evidence(monkeypatch):
    profile = new_custom_profile('Reference page evidence')
    profile.references.check_start_on_new_page = True
    snapshot = resolve_snapshot(profile)
    doc = Document()
    doc.add_paragraph('The body text preceding the Reference List.')
    doc.add_paragraph('References')
    doc.add_paragraph('Smith, A. (2020). A reference. Press.')
    buffer = io.BytesIO()
    doc.save(buffer)
    source = buffer.getvalue()
    findings = run_static_rules_engine(source, config=EffectiveProfileConfig(snapshot))
    audit = SimpleNamespace(
        profile_snapshot=snapshot.to_dict(), paragraph_page_mapping=None,
        violations=findings, weighted_score=calculate_weighted_score_detailed(findings).total,
    )
    from app.services import docx_pdf_converter
    def unavailable(_data):
        raise RuntimeError('renderer unavailable')
    monkeypatch.setattr(docx_pdf_converter, 'convert_docx_to_pdf', unavailable)
    with pytest.raises(GuidedFixFailed):
        verify_reaudit(audit, source, source, [])

@pytest.mark.parametrize('rule,attribute', [
    ('FONT_SIZE', 'szCs'), ('FONT_CONSISTENCY', 'asciiTheme'),
])
def test_alternate_font_slots_require_manual_correction(rule, attribute):
    document = Document(io.BytesIO(_doc()))
    run = document.paragraphs[0].runs[0]
    if rule == 'FONT_SIZE':
        from docx.oxml import OxmlElement
        alternate = OxmlElement('w:szCs')
        alternate.set(qn('w:val'), '22')
        run._r.rPr.append(alternate)
    else:
        run._r.rPr.rFonts.set(qn('w:asciiTheme'), 'minorHAnsi')
    buffer = io.BytesIO()
    document.save(buffer)
    finding = Violation(
        id='finding', audit_id='source', rule_code=rule, severity='MINOR',
        location={'paragraph_index': 0, 'run_index': 0}, message='m',
        actual_value='11pt' if rule == 'FONT_SIZE' else 'Times New Roman',
        expected_value='12pt' if rule == 'FONT_SIZE' else 'Arial',
    )
    audit = AuditRecord(id='source', filename='original.docx', status='completed')
    with pytest.raises(GuidedFixFailed, match='alternate font slot'):
        review_targets(audit, buffer.getvalue(), [finding])


def test_deleting_audit_revokes_unconsumed_output(client, monkeypatch, tmp_path):
    monkeypatch.setattr(guided_fix_storage.settings, 'GUIDED_FIX_STORAGE_DIR', str(tmp_path))
    source = _doc()
    audit = client.post('/api/audit', files={'file': ('original.docx', source)})
    audit_id = audit.json()['audit_id']
    ids = [v['id'] for v in audit.json()['physical_layout_errors'] if v['rule_code'] == 'FONT_SIZE']
    root = f'/api/audit/{audit_id}/guided-fixes'
    review = _upload(client, root + '/review', source, ids)
    assert review.status_code == 200, review.text
    applied = _upload(client, root, source, ids, review.json()['review_id'])
    assert applied.status_code == 200, applied.text
    assert len(list(tmp_path.glob('*.docx'))) == 1
    assert client.delete(f'/api/audit/{audit_id}').status_code == 200
    assert client.get(root + '/download/' + applied.json()['download_token']).status_code == 404
    assert list(tmp_path.glob('*.docx')) == []


@pytest.fixture
def bold_boundary_storage(monkeypatch, tmp_path):
    """Keep new candidate proofs offline and away from session/owner storage."""
    from app.api import routes
    from app.services import preview_storage

    monkeypatch.setattr(guided_fix_storage.settings, 'GUIDED_FIX_STORAGE_DIR', str(tmp_path / 'outputs'))
    monkeypatch.setattr(preview_storage.settings, 'PREVIEW_STORAGE_DIR', str(tmp_path / 'previews'))
    monkeypatch.setattr(guided_fix_storage, '_outputs', {})
    monkeypatch.setattr(routes, '_reviews', {})

    def no_renderer(_source):
        raise RuntimeError('Offline candidate test: rendering deliberately unavailable')

    monkeypatch.setattr(routes, 'convert_docx_to_pdf', no_renderer)
    return tmp_path / 'outputs'


def _bold_selection(audit):
    findings = [v for v in audit['physical_layout_errors'] if v['rule_code'] == BOLD_RULE]
    assert len(findings) == 1
    return f'/api/audit/{audit["audit_id"]}/guided-fixes', [findings[0]['id']]


def _saved_source_state(engine, audit_id):
    """Include every persisted Audit, Finding and citation field, not just score."""
    with Session(engine) as db:
        audit = db.get(AuditRecord, audit_id)

        def columns(row):
            return {column.name: copy.deepcopy(getattr(row, column.name))
                    for column in row.__table__.columns}

        return {
            'audit': columns(audit),
            'findings': sorted((columns(v) for v in audit.violations), key=lambda v: v['id']),
            'citations': sorted((columns(c) for c in audit.citation_issues), key=lambda c: c['id']),
        }


def _assert_no_bold_output(response, root, audit_id):
    assert 'download_token' not in response.json()
    assert 'review_id' not in response.json()
    assert not list(root.glob('*.docx'))
    assert not any(output.audit_id == audit_id for output in guided_fix_storage._outputs.values())


@pytest.mark.parametrize('mutation_fails', [False, True])
def test_reference_bold_and_alignment_selection_is_atomic_and_source_views_stay_saved(
    client, test_engine, monkeypatch, bold_boundary_storage, mutation_fails,
):
    from app.services import guided_fix
    from pypdf import PdfReader

    source = _bold_bytes(_bold_doc(segmented=True))
    audit = _bold_audit(client, source, alignment=True)
    root, bold_ids = _bold_selection(audit)
    alignment_ids = [v['id'] for v in audit['physical_layout_errors']
                     if v['rule_code'] == 'REFERENCE_HEADING_ALIGNMENT']
    assert len(alignment_ids) == 1
    ids = alignment_ids + bold_ids
    audit_path = f'/api/audit/{audit["audit_id"]}'
    saved = _saved_source_state(test_engine, audit['audit_id'])
    detail = client.get(audit_path).json()
    history = client.get('/api/audits').json()

    def report_text():
        response = client.get(audit_path + '/export-pdf')
        assert response.status_code == 200, response.text
        return '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(response.content)).pages)

    pdf_text = report_text()
    review = _upload(client, root + '/review', source, ids)
    assert review.status_code == 200, review.text
    assert {item['violation_id'] for item in review.json()['items']} == set(ids)
    token = review.json()['review_id']
    subset = _upload(client, root, source, bold_ids, token)
    assert subset.status_code == 422
    _assert_no_bold_output(subset, bold_boundary_storage, audit['audit_id'])
    if mutation_fails:
        monkeypatch.setattr(guided_fix, '_fix_reference_heading_bold', lambda *_args: False)
    applied = _upload(client, root, source, ids, token)
    if mutation_fails:
        assert applied.status_code == 422, applied.text
        _assert_no_bold_output(applied, bold_boundary_storage, audit['audit_id'])
    else:
        assert applied.status_code == 200, applied.text
        assert set(applied.json()['resolved']) == set(ids)
        assert applied.json()['new_findings'] == []
        download = client.get(root + '/download/' + applied.json()['download_token'])
        assert download.status_code == 200
        heading = Document(io.BytesIO(download.content)).paragraphs[1]
        assert heading.alignment == WD_ALIGN_PARAGRAPH.CENTER
        assert all(run.font.bold is True for run in heading.runs if run.text != '')
        assert heading.text == Document(io.BytesIO(source)).paragraphs[1].text
    assert _saved_source_state(test_engine, audit['audit_id']) == saved
    assert client.get(audit_path).json() == detail
    assert client.get('/api/audits').json() == history
    assert report_text() == pdf_text
    original_heading = Document(io.BytesIO(source)).paragraphs[1]
    assert original_heading.alignment == WD_ALIGN_PARAGRAPH.LEFT
    assert all(run.font.bold is False for run in original_heading.runs if run.text != '')


@pytest.mark.parametrize('variant,reason', [
    ('duplicate', 'ambiguous_heading'),
    ('inherited', 'unverifiable_bold'),
    ('unresolved', 'unverifiable_bold'),
    ('signed', 'unsupported_package'),
    ('protected', 'unsupported_package'),
    ('macro', 'unsupported_package'),
])
def test_reference_bold_review_safe_reasons_require_genuine_saved_source(
    client, test_engine, bold_boundary_storage, variant, reason,
):
    from app.services.guided_fix import ReferenceHeadingBoldUnavailable

    doc = _bold_doc(segmented=True)
    if variant == 'duplicate':
        doc.add_paragraph('References').runs[0].font.bold = False
    elif variant == 'inherited':
        doc.styles['Normal'].font.bold = False
        for run in doc.paragraphs[1].runs:
            run.font.bold = None
    elif variant == 'unresolved':
        doc.paragraphs[1].runs[1].font.bold = None
    elif variant == 'protected':
        doc.settings.element.append(OxmlElement('w:documentProtection'))
    source = _bold_bytes(doc)
    if variant in {'signed', 'macro'}:
        output = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(source)) as before, zipfile.ZipFile(output, 'w') as after:
            for item in before.infolist():
                after.writestr(item, before.read(item.filename))
            after.writestr('_xmlsignatures/sig1.xml' if variant == 'signed'
                           else 'word/vbaProject.bin', b'<marker/>')
        source = output.getvalue()
    audit = _bold_audit(client, source)
    with Session(test_engine) as db:
        saved = db.get(AuditRecord, audit['audit_id'])
        assert saved.document_sha256 == hashlib.sha256(source).hexdigest()
        finding = next((v for v in saved.violations if v.rule_code == BOLD_RULE), None)
        if finding is None:
            # Detector silence is not candidate safety evidence. Seed only
            # this test's persisted Finding, never fabricate the source hash.
            finding = Violation(
                audit_id=saved.id, rule_code=BOLD_RULE, severity='MINOR',
                location={'paragraph_index': 1}, message='Persisted heading bold finding',
                actual_value='Not bold', expected_value='Bold',
            )
            db.add(finding)
            db.commit()
        finding_id = finding.id
    before = _saved_source_state(test_engine, audit['audit_id'])
    root = f'/api/audit/{audit["audit_id"]}/guided-fixes'
    response = _upload(client, root + '/review', source, [finding_id])
    assert response.status_code == 422, response.text
    assert response.json() == {'detail': ReferenceHeadingBoldUnavailable.DETAILS[reason]}
    _assert_no_bold_output(response, bold_boundary_storage, audit['audit_id'])
    assert _saved_source_state(test_engine, audit['audit_id']) == before


def test_reference_bold_internal_review_exception_is_not_a_public_reason(
    client, monkeypatch, bold_boundary_storage,
):
    from app.api import routes

    source = _bold_bytes(_bold_doc())
    audit = _bold_audit(client, source)
    root, ids = _bold_selection(audit)

    def internal_error(*_args):
        raise RuntimeError('word/document.xml C:/private/source.docx SQL secret heading text')

    monkeypatch.setattr(routes, 'review_targets', internal_error)
    response = _upload(client, root + '/review', source, ids)
    assert response.status_code == 422
    assert response.json() == {'detail': 'Fix cannot be applied safely. Manual correction required.'}
    _assert_no_bold_output(response, bold_boundary_storage, audit['audit_id'])


@pytest.mark.parametrize('change,status', [
    ('wrong_original', 409), ('stale_actual', 422), ('stale_expected', 422),
    ('disabled', 422), ('future_snapshot', 409), ('no_snapshot', 409), ('no_hash', 409),
])
@pytest.mark.parametrize('phase', ['review', 'apply'])
def test_reference_bold_saved_candidate_gates_fail_closed(
    client, test_engine, bold_boundary_storage, change, status, phase,
):
    source = _bold_bytes(_bold_doc())
    audit = _bold_audit(client, source)
    root, ids = _bold_selection(audit)
    review_id = None
    if phase == 'apply':
        review = _upload(client, root + '/review', source, ids)
        assert review.status_code == 200, review.text
        review_id = review.json()['review_id']
    with Session(test_engine) as db:
        saved = db.get(AuditRecord, audit['audit_id'])
        finding = db.get(Violation, ids[0])
        if change == 'stale_actual':
            finding.actual_value = 'Bold'
        elif change == 'stale_expected':
            finding.expected_value = 'Not bold'
        elif change == 'disabled':
            profile = new_custom_profile('Disabled saved bold requirement')
            profile.references.check_heading_bold = False
            profile.references.heading_bold = True
            saved.profile_snapshot = resolve_snapshot(profile).to_dict()
        elif change == 'future_snapshot':
            snapshot = copy.deepcopy(saved.profile_snapshot)
            snapshot['schema_version'] = 999
            saved.profile_snapshot = snapshot
        elif change == 'no_snapshot':
            saved.profile_snapshot = None
        elif change == 'no_hash':
            saved.document_sha256 = None
        db.commit()
    before = _saved_source_state(test_engine, audit['audit_id'])
    if change == 'wrong_original':
        wrong = _bold_doc()
        wrong.paragraphs[0].add_run(' Different original.')
        source = _bold_bytes(wrong)
    response = _upload(client, root + ('/review' if phase == 'review' else ''), source, ids, review_id)
    assert response.status_code == status, response.text
    _assert_no_bold_output(response, bold_boundary_storage, audit['audit_id'])
    assert _saved_source_state(test_engine, audit['audit_id']) == before


def test_reference_bold_uses_saved_snapshot_after_current_profile_changes(
    client, test_engine, monkeypatch, bold_boundary_storage,
):
    from app.api import routes
    from app.services import profile_registry

    profile = new_custom_profile('Mutable current profile')
    profile.references.check_heading_bold = True
    profile.references.heading_bold = True
    # Replace the catalog with a task-owned profile, not an owner/global object.
    # Later edits must not affect this audit's saved formatting requirement.
    monkeypatch.setattr(profile_registry, 'BUILTIN_PROFILES', {profile.profile_id: profile})
    source = _bold_bytes(_bold_doc())
    response = client.post('/api/audit', params={'profile_id': profile.profile_id},
                           files={'file': ('original.docx', source)})
    assert response.status_code == 200, response.text
    audit = response.json()
    root, ids = _bold_selection(audit)
    saved = _saved_source_state(test_engine, audit['audit_id'])
    profile.references.heading_bold = False
    profile.references.check_heading_bold = False
    profile.profile_name = 'Changed current profile'

    def no_resolution(**_kwargs):
        pytest.fail('Guided correction must not re-resolve a current profile')

    monkeypatch.setattr(routes, 'resolve_request_profile', no_resolution)
    review = _upload(client, root + '/review', source, ids)
    assert review.status_code == 200, review.text
    assert review.json()['items'][0]['after'] == 'Bold'
    applied = _upload(client, root, source, ids, review.json()['review_id'])
    assert applied.status_code == 200, applied.text
    output = client.get(root + '/download/' + applied.json()['download_token'])
    assert output.status_code == 200
    assert Document(io.BytesIO(output.content)).paragraphs[1].runs[0].font.bold is True
    assert _saved_source_state(test_engine, audit['audit_id']) == saved


@pytest.mark.parametrize('failure', [
    'italic_mutation', 'reaudit_unavailable', 'baseline_drift',
    'new_finding', 'category_increase', 'storage_failure',
])
def test_reference_bold_never_publishes_unverified_or_unstored_copy(
    client, test_engine, monkeypatch, bold_boundary_storage, failure,
):
    from app.api import routes
    from app.services import guided_fix, guided_fix_verification
    from app.services.layout_violation import LayoutViolation

    source = _bold_bytes(_bold_doc(segmented=True))
    audit = _bold_audit(client, source)
    root, ids = _bold_selection(audit)
    review = _upload(client, root + '/review', source, ids)
    assert review.status_code == 200, review.text
    injected = []
    verification_errors = []
    original_verification = routes.verify_reaudit

    def observe_verification(*args):
        try:
            return original_verification(*args)
        except GuidedFixFailed as exc:
            verification_errors.append(str(exc))
            raise

    monkeypatch.setattr(routes, 'verify_reaudit', observe_verification)
    if failure == 'italic_mutation':
        original_fix = guided_fix._fix_reference_heading_bold

        def change_italic(run, expected):
            injected.append('italic')
            result = original_fix(run, expected)
            run.font.italic = not run.font.italic
            return result

        monkeypatch.setattr(guided_fix, '_fix_reference_heading_bold', change_italic)
    elif failure == 'baseline_drift':
        with Session(test_engine) as db:
            saved = db.get(AuditRecord, audit['audit_id'])
            saved.weighted_score -= 1
            db.commit()
        injected.append('persisted baseline score')
    elif failure in {'reaudit_unavailable', 'new_finding'}:
        original_engine = guided_fix_verification.run_static_rules_engine

        def changed_engine(data, **kwargs):
            injected.append(data)
            if failure == 'reaudit_unavailable':
                raise RuntimeError('C:/private/converter.docx internal re-audit failure')
            findings = original_engine(data, **kwargs)
            if data != source:
                findings.append(LayoutViolation(
                    rule_code='FONT_SIZE', severity='MINOR', location={'paragraph_index': 0, 'run_index': 0},
                    message='New unrelated finding', expected_value='12pt', actual_value='9pt',
                ))
            return findings

        monkeypatch.setattr(guided_fix_verification, 'run_static_rules_engine', changed_engine)
    elif failure == 'category_increase':
        original_score = guided_fix_verification.calculate_weighted_score_detailed

        def increased_category(findings):
            score = original_score(findings)
            injected.append(score)
            if len(injected) == 2:
                breakdown = [replace(row, deduction=row.deduction + 1)
                             if row.category == 'page_margins' else row for row in score.breakdown]
                return replace(score, total=score.total - 1, breakdown=breakdown)
            return score

        monkeypatch.setattr(guided_fix_verification, 'calculate_weighted_score_detailed', increased_category)
    else:
        def disk_failure(_fd):
            injected.append('fsync')
            raise OSError('C:/private/outputs disk write failed')

        monkeypatch.setattr(guided_fix_storage.os, 'fsync', disk_failure)
    if failure != 'storage_failure':
        def forbidden_publication(*_args):
            pytest.fail('Output storage must not be called before all verification gates pass')

        monkeypatch.setattr(guided_fix_storage, 'store', forbidden_publication)
    before = _saved_source_state(test_engine, audit['audit_id'])
    response = _upload(client, root, source, ids, review.json()['review_id'])
    assert response.status_code == (503 if failure == 'storage_failure' else 422), response.text
    assert injected
    if failure == 'category_increase':
        assert len(injected) == 2
    if failure == 'new_finding':
        assert len(injected) == 2
        assert injected[0] == source and injected[1] != source
    expected_error = {
        'reaudit_unavailable': 'deterministic re-audit unavailable',
        'baseline_drift': 'persisted score differs from baseline',
        'new_finding': 'new or worsened finding after re-audit',
        'category_increase': 'category deduction increased',
    }.get(failure)
    if expected_error is not None:
        assert verification_errors == [expected_error]
    if failure in {'reaudit_unavailable', 'baseline_drift', 'new_finding', 'category_increase'}:
        assert response.json() == {
            'detail': 'Fix applied; verification failed. No file was produced.',
        }
    elif failure == 'storage_failure':
        assert response.json() == {'detail': 'Verified copy could not be stored. Try again.'}
    _assert_no_bold_output(response, bold_boundary_storage, audit['audit_id'])
    assert _saved_source_state(test_engine, audit['audit_id']) == before


@pytest.fixture
def spacing_boundary_storage(bold_boundary_storage):
    return bold_boundary_storage


def _spacing_document():
    document = Document()
    paragraph = document.add_paragraph('A body paragraph with independently checked spacing.')
    paragraph.paragraph_format.space_before = Pt(20)
    paragraph.paragraph_format.space_after = Pt(20)
    paragraph.runs[0].font.name = 'Times New Roman'
    paragraph.runs[0].font.size = Pt(11)
    return document


def _spacing_layer(document, layer):
    from docx.enum.style import WD_STYLE_TYPE

    paragraph = document.paragraphs[0]
    if layer == 'direct':
        return paragraph._p.get_or_add_pPr()
    if layer in {'style', 'base'}:
        base = document.styles.add_style('Spacing proof base', WD_STYLE_TYPE.PARAGRAPH)
        used = document.styles.add_style('Spacing proof used', WD_STYLE_TYPE.PARAGRAPH)
        used.base_style = base
        paragraph.style = used
        return (used if layer == 'style' else base)._element.get_or_add_pPr()
    assert layer == 'default'
    styles = document.styles.element
    defaults = styles.find(qn('w:docDefaults'))
    if defaults is None:
        defaults = OxmlElement('w:docDefaults')
        styles.insert(0, defaults)
    wrapper = defaults.find(qn('w:pPrDefault'))
    if wrapper is None:
        wrapper = OxmlElement('w:pPrDefault')
        defaults.append(wrapper)
    properties = wrapper.find(qn('w:pPr'))
    if properties is None:
        properties = OxmlElement('w:pPr')
        wrapper.append(properties)
    return properties


def _spacing_control(properties, side, control, value):
    if control == 'contextualSpacing':
        node = OxmlElement('w:contextualSpacing')
        if value is not None:
            node.set(qn('w:val'), value)
        properties.append(node)
    else:
        spacing = properties.find(qn('w:spacing'))
        if spacing is None:
            spacing = OxmlElement('w:spacing')
            properties.append(spacing)
        spacing.set(qn('w:' + side + control), value)


def _spacing_audit(client, source, *, before=6, after=6):
    profile = new_custom_profile('Direct point spacing proof')
    profile.body.space_before_pt = before
    profile.body.space_after_pt = after
    profile.lists.space_after_pt = after
    response = client.post('/api/audit', data={'custom_profile': json.dumps(profile.to_dict())},
                           files={'file': ('spacing.docx', source)})
    assert response.status_code == 200, response.text
    return response.json()


def _spacing_selection(audit, sides=('before', 'after')):
    codes = {'SPACE_' + side.upper() for side in sides}
    findings = [finding for finding in audit['physical_layout_errors']
                if finding['rule_code'] in codes]
    assert {finding['rule_code'] for finding in findings} == codes
    assert all(finding['location']['paragraph_index'] == 0 for finding in findings)
    return f'/api/audit/{audit["audit_id"]}/guided-fixes', [finding['id'] for finding in findings]


def _assert_no_spacing_output(response, output_root, audit_id):
    from app.api import routes

    _assert_no_bold_output(response, output_root, audit_id)
    assert not any(review[0] == audit_id for review in routes._reviews.values())


@pytest.mark.parametrize('side', ['before', 'after'])
@pytest.mark.parametrize('layer', ['direct', 'style', 'base', 'default'])
@pytest.mark.parametrize('control,value', [
    ('Lines', '100'), ('Lines', '0'), ('Autospacing', '1'),
    ('contextualSpacing', '1'), ('contextualSpacing', None),
])
def test_spacing_override_never_publishes_a_copy(
    client, spacing_boundary_storage, side, layer, control, value,
):
    document = _spacing_document()
    _spacing_control(_spacing_layer(document, layer), side, control, value)
    source = _bold_bytes(document)
    digest = hashlib.sha256(source).digest()
    audit = _spacing_audit(client, source)
    root, ids = _spacing_selection(audit, (side,))
    response = _upload(client, root + '/review', source, ids)
    assert response.status_code == 422, response.text
    assert response.json() == {'detail': 'Fix cannot be applied safely. Manual correction required.'}
    _assert_no_spacing_output(response, spacing_boundary_storage, audit['audit_id'])
    assert hashlib.sha256(source).digest() == digest


def _spacing_finding_key(finding):
    return (finding.rule_code, finding.severity, json.dumps(finding.location, sort_keys=True),
            finding.actual_value, finding.expected_value)


@pytest.mark.parametrize('side', ['before', 'after'])
@pytest.mark.parametrize('required', [6, 0])
def test_point_spacing_review_apply_download_and_reaudit(
    client, test_engine, spacing_boundary_storage, side, required,
):
    from pypdf import PdfReader
    from app.services.profile_snapshot import snapshot_from_dict
    from tests.test_guided_fix_preservation_storage import (
        _assert_spacing_package_unchanged, _spacing_preservation_document,
    )

    document = _spacing_preservation_document()
    opposite = 'after' if side == 'before' else 'before'
    # Opposite-side overrides are irrelevant to the selected side and protected.
    _spacing_control(document.paragraphs[0]._p.pPr, opposite, 'Lines', '100')
    _spacing_control(document.paragraphs[0]._p.pPr, opposite, 'Autospacing', '1')
    source = _bold_bytes(document)
    original = bytes(source)
    digest = hashlib.sha256(source).hexdigest()
    audit = _spacing_audit(client, source, **{side: required})
    root, ids = _spacing_selection(audit, (side,))
    path = f'/api/audit/{audit["audit_id"]}'
    saved = _saved_source_state(test_engine, audit['audit_id'])
    detail, history = client.get(path).json(), client.get('/api/audits').json()

    def report_text():
        response = client.get(path + '/export-pdf')
        assert response.status_code == 200, response.text
        return '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(response.content)).pages)

    report = report_text()
    review = _upload(client, root + '/review', source, ids)
    assert review.status_code == 200, review.text
    assert [item['violation_id'] for item in review.json()['items']] == ids
    assert review.json()['items'][0]['locations'] == ['Paragraph 1']
    applied = _upload(client, root, source, ids, review.json()['review_id'])
    assert applied.status_code == 200, applied.text
    assert applied.json()['status'] == 'passed'
    assert applied.json()['resolved'] == ids
    assert applied.json()['new_findings'] == []
    assert _upload(client, root, source, ids, review.json()['review_id']).status_code == 409
    download_path = root + '/download/' + applied.json()['download_token']
    download = client.get(download_path)
    assert download.status_code == 200
    assert download.headers['cache-control'] == 'private, no-store'
    assert client.get(download_path).status_code == 410
    assert download.content != source
    assert hashlib.sha256(download.content).hexdigest() != digest
    _assert_spacing_package_unchanged(source, download.content, {0: {side: required * 20}})
    output = Document(io.BytesIO(download.content))
    spacing = output.paragraphs[0]._p.pPr.find(qn('w:spacing'))
    assert spacing.get(qn('w:' + side)) == str(required * 20)
    assert spacing.get(qn('w:' + opposite + 'Lines')) == '100'
    assert spacing.get(qn('w:' + opposite + 'Autospacing')) == '1'
    config = EffectiveProfileConfig(snapshot_from_dict(saved['audit']['profile_snapshot']))
    before = run_static_rules_engine(source, config=config)
    after = run_static_rules_engine(download.content, config=config)
    code = 'SPACE_' + side.upper()
    selected = [finding for finding in before if finding.rule_code == code
                and finding.location == {'paragraph_index': 0}]
    assert len(selected) == 1
    assert not [finding for finding in after if finding.rule_code == code
                and finding.location == {'paragraph_index': 0}]
    assert sorted(map(_spacing_finding_key, after)) == sorted(
        _spacing_finding_key(finding) for finding in before if finding not in selected
    )
    before_score, after_score = [calculate_weighted_score_detailed(findings) for findings in (before, after)]
    assert after_score.total >= before_score.total
    deductions = {row.category: row.deduction for row in before_score.breakdown}
    assert all(row.deduction <= deductions[row.category] for row in after_score.breakdown)
    assert source == original and hashlib.sha256(source).hexdigest() == digest
    assert saved['audit']['document_sha256'] == digest
    assert _saved_source_state(test_engine, audit['audit_id']) == saved
    assert client.get(path).json() == detail
    assert client.get('/api/audits').json() == history
    assert report_text() == report


@pytest.mark.parametrize('side', ['before', 'after'])
def test_spacing_unrepresentable_requirement_remains_manual(client, spacing_boundary_storage, side):
    source = _bold_bytes(_spacing_document())
    audit = _spacing_audit(client, source, **{side: 6.01})
    root, ids = _spacing_selection(audit, (side,))
    response = _upload(client, root + '/review', source, ids)
    assert response.status_code == 422, response.text
    _assert_no_spacing_output(response, spacing_boundary_storage, audit['audit_id'])


@pytest.mark.parametrize('side', ['before', 'after'])
@pytest.mark.parametrize('control', ['Autospacing', 'contextualSpacing'])
@pytest.mark.parametrize('false_value', ['0', 'false', 'off'])
@pytest.mark.parametrize('inherited_layer', ['style', 'base', 'default'])
def test_spacing_valid_false_overrides_inherited_true(
    client, spacing_boundary_storage, side, control, false_value, inherited_layer,
):
    document = _spacing_document()
    _spacing_control(_spacing_layer(document, inherited_layer), side, control, 'true')
    _spacing_control(_spacing_layer(document, 'direct'), side, control, false_value)
    source = _bold_bytes(document)
    audit = _spacing_audit(client, source)
    root, ids = _spacing_selection(audit, (side,))
    review = _upload(client, root + '/review', source, ids)
    assert review.status_code == 200, review.text
    applied = _upload(client, root, source, ids, review.json()['review_id'])
    assert applied.status_code == 200, applied.text
    download = client.get(root + '/download/' + applied.json()['download_token'])
    assert download.status_code == 200
    output = Document(io.BytesIO(download.content))
    properties = output.paragraphs[0]._p.pPr
    assert properties.find(qn('w:spacing')).get(qn('w:' + side)) == '120'
    if control == 'contextualSpacing':
        assert properties.find(qn('w:contextualSpacing')).get(qn('w:val')) == false_value
    else:
        assert properties.find(qn('w:spacing')).get(qn('w:' + side + control)) == false_value


@pytest.mark.parametrize('side', ['before', 'after'])
@pytest.mark.parametrize('control', ['Autospacing', 'contextualSpacing'])
def test_spacing_false_does_not_hide_malformed_inherited_control(
    client, spacing_boundary_storage, side, control,
):
    document = _spacing_document()
    _spacing_control(_spacing_layer(document, 'base'), side, control, 'invalid')
    _spacing_control(_spacing_layer(document, 'direct'), side, control, '0')
    source = _bold_bytes(document)
    audit = _spacing_audit(client, source)
    root, ids = _spacing_selection(audit, (side,))
    response = _upload(client, root + '/review', source, ids)
    assert response.status_code == 422, response.text
    _assert_no_spacing_output(response, spacing_boundary_storage, audit['audit_id'])


@pytest.mark.parametrize('unsafe', [False, True])
def test_spacing_before_after_selection_is_atomic(client, spacing_boundary_storage, unsafe):
    document = _spacing_document()
    if unsafe:
        _spacing_control(_spacing_layer(document, 'direct'), 'after', 'Autospacing', 'on')
    source = _bold_bytes(document)
    audit = _spacing_audit(client, source, before=6, after=0)
    root, ids = _spacing_selection(audit)
    response = _upload(client, root + '/review', source, ids)
    if unsafe:
        assert response.status_code == 422, response.text
        _assert_no_spacing_output(response, spacing_boundary_storage, audit['audit_id'])
        return
    assert response.status_code == 200, response.text
    assert {item['violation_id'] for item in response.json()['items']} == set(ids)
    applied = _upload(client, root, source, ids, response.json()['review_id'])
    assert applied.status_code == 200, applied.text
    assert set(applied.json()['resolved']) == set(ids)
    download = client.get(root + '/download/' + applied.json()['download_token'])
    assert download.status_code == 200
    spacing = Document(io.BytesIO(download.content)).paragraphs[0]._p.pPr.find(qn('w:spacing'))
    assert spacing.get(qn('w:before')) == '120'
    assert spacing.get(qn('w:after')) == '0'


@pytest.mark.parametrize('side', ['before', 'after'])
@pytest.mark.parametrize('fault', ['auto', 'lines', 'contextual', 'one_twip', 'partial'])
def test_spacing_output_override_is_rejected(
    client, monkeypatch, spacing_boundary_storage, side, fault,
):
    from app.services import guided_fix
    from app.services.profile_snapshot import snapshot_from_dict

    source = _bold_bytes(_spacing_document())
    audit = _spacing_audit(client, source)
    root, ids = _spacing_selection(audit, ('before', 'after') if fault == 'partial' else (side,))
    review = _upload(client, root + '/review', source, ids)
    assert review.status_code == 200, review.text
    original_mutator = getattr(guided_fix, '_fix_space_' + side)
    original_validator = guided_fix._validate_output
    errors, silent_outputs = [], []

    def faulty_mutator(paragraph, required):
        if fault == 'partial':
            return True
        assert original_mutator(paragraph, required)
        if fault == 'one_twip':
            paragraph._p.pPr.find(qn('w:spacing')).set(qn('w:' + side), str(round(required * 20) + 1))
        else:
            control = {'auto': 'Autospacing', 'lines': 'Lines', 'contextual': 'contextualSpacing'}[fault]
            _spacing_control(paragraph._p.pPr, side, control, '1')
        return True

    def inspected_validator(data, *args):
        if fault != 'partial':
            with zipfile.ZipFile(io.BytesIO(data)) as package:
                assert package.read('word/document.xml')
            # The real detector's silence must not substitute for raw output proof.
            snapshot = snapshot_from_dict(args[3].profile_snapshot)
            findings = run_static_rules_engine(data, config=EffectiveProfileConfig(snapshot))
            assert not [finding for finding in findings if finding.rule_code == 'SPACE_' + side.upper()]
            silent_outputs.append(data)
        try:
            return original_validator(data, *args)
        except GuidedFixFailed as exc:
            errors.append(str(exc))
            raise

    def forbidden_publication(*_args):
        pytest.fail('Unsafe spacing output reached storage')

    monkeypatch.setattr(guided_fix, '_fix_space_' + side, faulty_mutator)
    monkeypatch.setattr(guided_fix, '_validate_output', inspected_validator)
    monkeypatch.setattr(guided_fix_storage, 'store', forbidden_publication)
    response = _upload(client, root, source, ids, review.json()['review_id'])
    assert response.status_code == 422, response.text
    assert errors
    assert bool(silent_outputs) is (fault != 'partial')
    _assert_no_spacing_output(response, spacing_boundary_storage, audit['audit_id'])


def _ambiguous_spacing_document(side, variant, layer='direct'):
    document = _spacing_document()
    properties = _spacing_layer(document, layer)
    spacing = properties.find(qn('w:spacing'))
    if spacing is None:
        spacing = OxmlElement('w:spacing')
        properties.append(spacing)
    if variant == 'duplicate_spacing':
        properties.append(copy.deepcopy(spacing))
    elif variant == 'duplicate_pPr':
        properties.getparent().append(copy.deepcopy(properties))
    elif variant == 'duplicate_contextual':
        _spacing_control(properties, side, 'contextualSpacing', '0')
        _spacing_control(properties, side, 'contextualSpacing', '0')
    elif variant == 'unknown_attribute':
        spacing.set(qn('w:unknownSpacingControl'), '1')
    elif variant == 'spacing_child':
        spacing.append(OxmlElement('w:before'))
    elif variant == 'spacing_text':
        spacing.text = 'not a leaf'
    elif variant == 'contextual_child':
        _spacing_control(properties, side, 'contextualSpacing', '0')
        properties.find(qn('w:contextualSpacing')).append(OxmlElement('w:val'))
    elif variant == 'numbering':
        num = OxmlElement('w:numPr')
        identifier = OxmlElement('w:numId')
        identifier.set(qn('w:val'), '1')
        num.append(identifier)
        properties.append(num)
    elif variant == 'revision':
        properties.append(OxmlElement('w:pPrChange'))
    elif variant == 'alternate_content':
        from lxml import etree
        properties.append(etree.Element('{http://schemas.openxmlformats.org/markup-compatibility/2006}AlternateContent'))
    elif variant in {'missing_style', 'wrong_kind_style', 'cycle', 'duplicate_style',
                     'duplicate_pStyle', 'missing_base', 'duplicate_basedOn'}:
        _spacing_layer(document, 'style')
        paragraph = document.paragraphs[0]
        style = paragraph.style
        if variant == 'missing_style':
            paragraph._p.pPr.find(qn('w:pStyle')).set(qn('w:val'), 'MissingSpacingStyle')
        elif variant == 'wrong_kind_style':
            style._element.set(qn('w:type'), 'character')
        elif variant == 'cycle':
            style.base_style.base_style = style
        elif variant == 'duplicate_style':
            document.styles.element.append(copy.deepcopy(style._element))
        elif variant == 'duplicate_pStyle':
            paragraph._p.pPr.append(copy.deepcopy(paragraph._p.pPr.find(qn('w:pStyle'))))
        elif variant == 'missing_base':
            style._element.find(qn('w:basedOn')).set(qn('w:val'), 'MissingSpacingBase')
        else:
            style._element.append(copy.deepcopy(style._element.find(qn('w:basedOn'))))
    elif variant == 'duplicate_default':
        normal = document.styles['Normal']._element
        duplicate = copy.deepcopy(normal)
        duplicate.set(qn('w:styleId'), 'AnotherDefaultParagraph')
        document.styles.element.append(duplicate)
    else:
        raise AssertionError('Unknown spacing fixture')
    return document


@pytest.mark.parametrize('side', ['before', 'after'])
@pytest.mark.parametrize('variant', [
    'duplicate_spacing', 'duplicate_pPr', 'duplicate_contextual', 'unknown_attribute',
    'missing_style', 'wrong_kind_style', 'cycle', 'duplicate_style', 'duplicate_pStyle',
    'missing_base', 'duplicate_basedOn', 'duplicate_default',
])
def test_spacing_structural_and_used_style_ambiguity_never_publishes(
    client, spacing_boundary_storage, side, variant,
):
    source = _bold_bytes(_ambiguous_spacing_document(side, variant))
    audit = _spacing_audit(client, source)
    root, ids = _spacing_selection(audit, (side,))
    response = _upload(client, root + '/review', source, ids)
    assert response.status_code == 422, response.text
    _assert_no_spacing_output(response, spacing_boundary_storage, audit['audit_id'])


@pytest.mark.parametrize('layer', ['direct', 'style', 'base', 'default'])
def test_spacing_numbering_evidence_is_manual_at_every_used_layer(
    client, spacing_boundary_storage, layer,
):
    source = _bold_bytes(_ambiguous_spacing_document('after', 'numbering', layer))
    audit = _spacing_audit(client, source)
    root, ids = _spacing_selection(audit, ('after',))
    response = _upload(client, root + '/review', source, ids)
    assert response.status_code == 422, response.text
    _assert_no_spacing_output(response, spacing_boundary_storage, audit['audit_id'])


@pytest.mark.parametrize('side', ['before', 'after'])
@pytest.mark.parametrize('layer', ['direct', 'style', 'base', 'default'])
@pytest.mark.parametrize('variant', [
    'spacing_child', 'spacing_text', 'contextual_child', 'revision', 'alternate_content',
])
def test_spacing_raw_evidence_rejects_unreadable_used_containers(side, layer, variant):
    from app.services.guided_fix import _direct_spacing_points

    document = _ambiguous_spacing_document(side, variant, layer)
    source = _bold_bytes(document)
    reopened = Document(io.BytesIO(source))
    before = (reopened._element.xml, reopened.styles.element.xml)
    with pytest.raises(GuidedFixFailed):
        _direct_spacing_points(reopened.paragraphs[0], 'SPACE_' + side.upper())
    assert (reopened._element.xml, reopened.styles.element.xml) == before


@pytest.mark.parametrize('side', ['before', 'after'])
@pytest.mark.parametrize('value', ['-1', '1.5', 'NaN', 'inf', '', ' 400', '+400'])
def test_spacing_raw_points_require_nonnegative_integral_twips(side, value):
    from app.services.guided_fix import _direct_spacing_points

    document = _spacing_document()
    document.paragraphs[0]._p.pPr.find(qn('w:spacing')).set(qn('w:' + side), value)
    with pytest.raises(GuidedFixFailed):
        _direct_spacing_points(document.paragraphs[0], 'SPACE_' + side.upper())


@pytest.mark.parametrize('side', ['before', 'after'])
def test_spacing_missing_direct_points_cannot_fall_back_to_inheritance(side):
    from app.services.guided_fix import _direct_spacing_points

    document = _spacing_document()
    properties = _spacing_layer(document, 'style')
    inherited = OxmlElement('w:spacing')
    inherited.set(qn('w:' + side), '400')
    properties.append(inherited)
    del document.paragraphs[0]._p.pPr.find(qn('w:spacing')).attrib[qn('w:' + side)]
    with pytest.raises(GuidedFixFailed):
        _direct_spacing_points(document.paragraphs[0], 'SPACE_' + side.upper())


@pytest.mark.parametrize('side', ['before', 'after'])
def test_spacing_unused_broken_styles_do_not_reduce_safe_direct_point_availability(
    client, spacing_boundary_storage, side,
):
    from docx.enum.style import WD_STYLE_TYPE
    from tests.test_guided_fix_preservation_storage import _assert_spacing_package_unchanged

    document = _spacing_document()
    unused = document.styles.add_style('Unused broken spacing', WD_STYLE_TYPE.PARAGRAPH)
    unused.base_style = unused
    _spacing_control(unused._element.get_or_add_pPr(), side, 'Autospacing', 'invalid')
    source = _bold_bytes(document)
    audit = _spacing_audit(client, source)
    root, ids = _spacing_selection(audit, (side,))
    review = _upload(client, root + '/review', source, ids)
    assert review.status_code == 200, review.text
    applied = _upload(client, root, source, ids, review.json()['review_id'])
    assert applied.status_code == 200, applied.text
    download = client.get(root + '/download/' + applied.json()['download_token'])
    assert download.status_code == 200
    _assert_spacing_package_unchanged(source, download.content, {0: {side: 120}})


@pytest.mark.parametrize('side', ['before', 'after'])
@pytest.mark.parametrize('change,status', [
    ('wrong_original', 409), ('stale_actual', 422), ('stale_expected', 422),
    ('no_snapshot', 409), ('future_snapshot', 409), ('no_hash', 409),
    ('corrupt_snapshot', 409),
])
def test_spacing_saved_evidence_gates_leave_original_history_unchanged(
    client, test_engine, spacing_boundary_storage, side, change, status,
):
    source = _bold_bytes(_spacing_document())
    audit = _spacing_audit(client, source)
    root, ids = _spacing_selection(audit, (side,))
    review = _upload(client, root + '/review', source, ids)
    assert review.status_code == 200, review.text
    with Session(test_engine) as db:
        saved = db.get(AuditRecord, audit['audit_id'])
        finding = db.get(Violation, ids[0])
        if change == 'stale_actual':
            finding.actual_value = '10pt'
        elif change == 'stale_expected':
            finding.expected_value = '8pt'
        elif change == 'no_snapshot':
            saved.profile_snapshot = None
        elif change == 'future_snapshot':
            snapshot = copy.deepcopy(saved.profile_snapshot)
            snapshot['schema_version'] = 999
            saved.profile_snapshot = snapshot
        elif change == 'corrupt_snapshot':
            snapshot = copy.deepcopy(saved.profile_snapshot)
            snapshot['fingerprint'] = '0' * 64
            saved.profile_snapshot = snapshot
        elif change == 'no_hash':
            saved.document_sha256 = None
        db.commit()
    before = _saved_source_state(test_engine, audit['audit_id'])
    if change == 'wrong_original':
        changed = _spacing_document()
        changed.paragraphs[0].add_run(' A different original.')
        source = _bold_bytes(changed)
    response = _upload(client, root, source, ids, review.json()['review_id'])
    assert response.status_code == status, response.text
    _assert_no_bold_output(response, spacing_boundary_storage, audit['audit_id'])
    assert _saved_source_state(test_engine, audit['audit_id']) == before


@pytest.mark.parametrize('rule', ['LINE_SPACING', '', None])
def test_spacing_raw_oracle_does_not_expand_to_other_operations(rule):
    from app.services.guided_fix import _direct_spacing_points

    with pytest.raises(GuidedFixFailed):
        _direct_spacing_points(_spacing_document().paragraphs[0], rule)


@pytest.mark.parametrize('side', ['before', 'after'])
def test_spacing_raw_oracle_requires_main_body_context(side):
    from app.services.guided_fix import _direct_spacing_points

    document = _spacing_document()
    table_paragraph = document.add_table(rows=1, cols=1).cell(0, 0).paragraphs[0]
    table_paragraph.paragraph_format.space_before = Pt(20)
    table_paragraph.paragraph_format.space_after = Pt(20)
    header_paragraph = document.sections[0].header.paragraphs[0]
    header_paragraph.paragraph_format.space_before = Pt(20)
    header_paragraph.paragraph_format.space_after = Pt(20)
    for paragraph in (table_paragraph, header_paragraph, None):
        with pytest.raises(GuidedFixFailed):
            _direct_spacing_points(paragraph, 'SPACE_' + side.upper())


@pytest.mark.parametrize('side', ['before', 'after'])
def test_spacing_saved_requirement_survives_current_profile_change(
    client, test_engine, monkeypatch, spacing_boundary_storage, side,
):
    from datetime import datetime
    from app.services import profile_registry
    from tests.test_guided_fix_preservation_storage import _assert_spacing_package_unchanged

    profile = new_custom_profile('Historical direct point spacing')
    profile.body.space_before_pt = 6
    profile.body.space_after_pt = 6
    monkeypatch.setattr(profile_registry, 'BUILTIN_PROFILES', {profile.profile_id: profile})
    source = _bold_bytes(_spacing_document())
    response = client.post('/api/audit', params={'profile_id': profile.profile_id},
                           files={'file': ('historical.docx', source)})
    assert response.status_code == 200, response.text
    audit = response.json()
    root, ids = _spacing_selection(audit, (side,))
    with Session(test_engine) as db:
        db.get(AuditRecord, audit['audit_id']).created_at = datetime(2024, 1, 1)
        db.commit()
    saved = _saved_source_state(test_engine, audit['audit_id'])
    profile.body.space_before_pt = 12
    profile.body.space_after_pt = 12
    review = _upload(client, root + '/review', source, ids)
    assert review.status_code == 200, review.text
    applied = _upload(client, root, source, ids, review.json()['review_id'])
    assert applied.status_code == 200, applied.text
    download = client.get(root + '/download/' + applied.json()['download_token'])
    assert download.status_code == 200
    _assert_spacing_package_unchanged(source, download.content, {0: {side: 120}})
    assert _saved_source_state(test_engine, audit['audit_id']) == saved


@pytest.mark.parametrize('side', ['before', 'after'])
@pytest.mark.parametrize('layer', ['direct', 'style', 'base', 'default'])
@pytest.mark.parametrize('variant', ['duplicate_spacing', 'duplicate_pPr', 'duplicate_contextual'])
def test_spacing_duplicate_containers_reject_in_all_used_layers(side, layer, variant):
    from app.services.guided_fix import _direct_spacing_points

    document = _ambiguous_spacing_document(side, variant, layer)
    with pytest.raises(GuidedFixFailed):
        _direct_spacing_points(document.paragraphs[0], 'SPACE_' + side.upper())


@pytest.mark.parametrize('side', ['before', 'after'])
@pytest.mark.parametrize('control', ['Autospacing', 'contextualSpacing'])
@pytest.mark.parametrize('literal', ['TRUE', 'False', 'yes', '2', '', ' false'])
def test_spacing_control_literals_are_exact_not_python_truthiness(side, control, literal):
    from app.services.guided_fix import _direct_spacing_points

    document = _spacing_document()
    _spacing_control(_spacing_layer(document, 'direct'), side, control, literal)
    with pytest.raises(GuidedFixFailed):
        _direct_spacing_points(document.paragraphs[0], 'SPACE_' + side.upper())


@pytest.mark.parametrize('variant', [
    'missing_styles_relationship', 'duplicate_docDefaults', 'duplicate_pPrDefault',
    'duplicate_default_pPr', 'duplicate_base_reference', 'missing_default_style',
])
def test_spacing_style_and_default_context_must_be_complete(variant):
    from app.services.guided_fix import _direct_spacing_points

    document = _spacing_document()
    defaults = _spacing_layer(document, 'default')
    if variant == 'missing_styles_relationship':
        relationship = next(identifier for identifier, relationship in document.part.rels.items()
                            if relationship.reltype.endswith('/styles'))
        del document.part.rels[relationship]
    elif variant == 'duplicate_docDefaults':
        document.styles.element.append(copy.deepcopy(defaults.getparent().getparent()))
    elif variant == 'duplicate_pPrDefault':
        defaults.getparent().getparent().append(copy.deepcopy(defaults.getparent()))
    elif variant == 'duplicate_default_pPr':
        defaults.getparent().append(copy.deepcopy(defaults))
    elif variant == 'duplicate_base_reference':
        _spacing_layer(document, 'style')
        style = document.paragraphs[0].style._element
        style.append(copy.deepcopy(style.find(qn('w:basedOn'))))
    else:
        for style in document.styles.element.findall(qn('w:style')):
            if style.get(qn('w:type')) == 'paragraph':
                style.attrib.pop(qn('w:default'), None)
    with pytest.raises(GuidedFixFailed):
        _direct_spacing_points(document.paragraphs[0], 'SPACE_BEFORE')
