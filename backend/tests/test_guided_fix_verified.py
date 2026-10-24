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
