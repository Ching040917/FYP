"""The correction is downloadable only after independent verification."""
import hashlib
import io
import json

from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn

import pytest

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
