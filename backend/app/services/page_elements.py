"""Internal, transient DOCX section/story evidence; never invoked by auditing.

Reads raw relationships without creating missing stories or changing fields. Story
paragraph indexes are local and never enter body document_blocks. Null values and
unresolved/unsupported states prohibit complete comparison or absence claims.
Activation and alignment are structural declarations, not rendered-page ownership
or geometry. Cached fields are not evaluated; no page sequence is computed.
"""

import re

from docx.document import Document
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.text.paragraph import Paragraph
from docx.text.run import Run

from app.services.document_parser import resolve_effective_family, resolve_effective_size

_VARIANTS = ("default", "first", "even")
_KINDS = ("header", "footer")
_FIELD_KINDS = {"PAGE", "NUMPAGES", "SECTION", "SECTIONPAGES"}
_BREAKS = {"nextPage", "continuous", "oddPage", "evenPage", "nextColumn"}
_NUMBER_FORMATS = set("""
decimal upperRoman lowerRoman upperLetter lowerLetter ordinal cardinalText ordinalText
hex chicago ideographDigital japaneseCounting aiueo iroha decimalFullWidth decimalHalfWidth
japaneseLegal japaneseDigitalTenThousand decimalEnclosedCircle decimalFullWidth2 aiueoFullWidth
irohaFullWidth decimalZero bullet ganada chosung decimalEnclosedFullstop decimalEnclosedParen
decimalEnclosedCircleChinese ideographEnclosedCircle ideographTraditional ideographZodiac
ideographZodiacTraditional taiwaneseCounting ideographLegalTraditional taiwaneseCountingThousand
taiwaneseDigital chineseCounting chineseLegalSimplified chineseCountingThousand koreanDigital
koreanCounting koreanLegal koreanDigital2 vietnameseCounting russianLower russianUpper none
numberInDash hebrew1 hebrew2 arabicAlpha arabicAbjad hindiVowels hindiConsonants hindiNumbers
hindiCounting thaiLetters thaiNumbers thaiCounting bahtText dollarText custom
""".split())
_FLAGS = ("tables", "drawings", "text_boxes", "shapes", "alternate_content",
          "tracked_revisions", "unsupported_fields", "external_relationships",
          "unsupported_containers", "hidden_text", "automatic_numbering")
_SPECIAL = {
    qn("w:tbl"): "tables", qn("w:drawing"): "drawings",
    qn("w:pict"): "shapes", qn("w:txbxContent"): "text_boxes",
    "{http://schemas.openxmlformats.org/markup-compatibility/2006}AlternateContent": "alternate_content",
    **{qn("w:" + name): "tracked_revisions" for name in
       ("ins", "del", "moveFrom", "moveTo", "rPrChange", "pPrChange")},
}
_TEXT = {qn("w:t"): None, qn("w:tab"): "\t", qn("w:br"): "\n",
         qn("w:cr"): "\n", qn("w:noBreakHyphen"): "\u2011",
         qn("w:softHyphen"): "\u00ad"}


def _children(element, name):
    return [] if element is None else element.findall(qn("w:" + name))


def _on_off(elements):
    if not elements:
        return False
    if len(elements) != 1:
        return None
    value = elements[0].get(qn("w:val"), "true")
    if value in ("1", "true", "on"):
        return True
    if value in ("0", "false", "off"):
        return False
    return None


def _raw(element, name):
    return None if element is None else element.get(qn("w:" + name))


def _single(element, name):
    values = _children(element, name)
    return values[0] if len(values) == 1 else None


def _document_part_xml(document, relationship_type, root_name):
    relationships = [rel for rel in document.part.rels.values() if rel.reltype == relationship_type]
    if not relationships:
        return None, "absent"
    if len(relationships) != 1 or relationships[0].is_external:
        return None, "unresolved"
    root = getattr(relationships[0].target_part, "element", None)
    if root is None or root.tag != qn("w:" + root_name):
        return None, "unresolved"
    return root, "resolved"


def _numbering(sect):
    declarations = _children(sect, "pgNumType")
    keys = {"format": "fmt", "start": "start", "chapter_style": "chapStyle",
            "chapter_separator": "chapSep"}
    result = {key: _raw(declarations[0], attr) if len(declarations) == 1 else None
              for key, attr in keys.items()}
    reasons = []
    if len(declarations) > 1:
        reasons.append("duplicate_numbering_declaration")
    for key in ("start", "chapter_style"):
        value = result[key]
        if value is not None and (not re.fullmatch(r"[0-9]{1,10}", value)
                                  or int(value) > 2147483647
                                  or (key == "chapter_style" and not 1 <= int(value) <= 9)):
            reasons.append("invalid_" + key)
    if result["format"] is not None and result["format"] not in _NUMBER_FORMATS:
        reasons.append("unrecognized_format")
    if result["chapter_separator"] is not None and result["chapter_separator"] not in (
            "hyphen", "period", "colon", "emDash", "enDash"):
        reasons.append("invalid_chapter_separator")
    result.update(status="unresolved" if reasons else "resolved", reasons=reasons)
    return result


def _distance(sect, kind):
    margin = _single(sect, "pgMar")
    value = _raw(margin, kind)
    if value is None or not re.fullmatch(r"[0-9]{1,10}", value):
        return None
    return int(value) / 1440.0


def _classify(field):
    if field["reasons"]:
        field["kind"] = "unresolved"
        field["status"] = "unresolved"
    else:
        tokens = field["instruction"].split()
        token = tokens[0].upper() if tokens else ""
        if not token:
            field["reasons"].append("missing_instruction")
            field["kind"] = "unresolved"
            field["status"] = "unresolved"
        else:
            field["kind"] = token if token in _FIELD_KINDS else "other"
            field["status"] = "resolved"


def _new_field(form, index, instruction=""):
    return dict(kind="unresolved", form=form, instruction=instruction,
                cached_result="", paragraph_index=index, status="unresolved", reasons=[])

def _property_layers(run, paragraph, styles):
    """Yield explicit owning-document run-property layers without theme inference."""
    yield _single(run._element, "rPr")
    if styles is None:
        return
    for anchor in (run.style, paragraph.style):
        seen = set()
        style = anchor
        while style is not None and style.style_id not in seen:
            seen.add(style.style_id)
            yield _single(style.element, "rPr")
            style = style.base_style
    defaults = _single(_single(styles, "docDefaults"), "rPrDefault")
    yield _single(defaults, "rPr")


def _hidden(run, paragraph, styles):
    """Conservatively exclude style-toggle visibility; direct false is absolute."""
    layers = list(_property_layers(run, paragraph, styles))
    for name in ("vanish", "webHidden", "specVanish"):
        for layer_index, layer in enumerate(layers):
            declarations = _children(layer, name)
            if declarations:
                if _on_off(declarations) is not False:
                    return True
                if layer_index == 0:
                    break
    return False


def _numbered(paragraph, styles):
    properties = [_single(paragraph._p, "pPr")]
    style = paragraph.style if styles is not None else None
    seen = set()
    while style is not None and style.style_id not in seen:
        seen.add(style.style_id)
        properties.append(_single(style.element, "pPr"))
        style = style.base_style
    for layer in properties:
        declarations = _children(layer, "numPr")
        if declarations:
            return not (len(declarations) == 1 and
                        _raw(_single(declarations[0], "numId"), "val") == "0")
    return False


def _format_run(element, paragraph, index, styles, style_ids):
    run = Run(element, paragraph)
    rpr = _single(element, "rPr")
    fonts = _single(rpr, "rFonts")
    size = _raw(_single(rpr, "sz"), "val")
    if styles is None:
        # Do not let style accessors create a missing styles relationship.
        family, family_source = None, "unresolved"
        effective_size, size_source = None, "unresolved"
    else:
        family, family_source = resolve_effective_family(run, paragraph, styles)
        effective_size, size_source = resolve_effective_size(run, paragraph, styles)
    # A theme-only override blocks an inherited concrete family. The shared
    # resolver intentionally does not resolve themes; do not skip that override.
    for layer in _property_layers(run, paragraph, styles):
        declaration = _single(layer, "rFonts")
        if declaration is not None:
            if _raw(declaration, "ascii") or _raw(declaration, "hAnsi"):
                break
            if _raw(declaration, "asciiTheme") or _raw(declaration, "hAnsiTheme"):
                family, family_source = None, "unresolved"
                break
    malformed = len(_children(element, "rPr")) > 1
    for layer in _property_layers(run, paragraph, styles):
        for name in ("rFonts", "sz", "rStyle", "b", "i"):
            malformed |= len(_children(layer, name)) > 1
        for name in ("b", "i"):
            if _children(layer, name) and _on_off(_children(layer, name)) is None:
                malformed = True
        declared_size = _raw(_single(layer, "sz"), "val")
        if declared_size is not None and (
                not re.fullmatch(r"[0-9]{1,10}", declared_size) or int(declared_size) <= 0):
            malformed = True
        if any(_children(layer, name) and _on_off(_children(layer, name)) is not False
               for name in ("cs", "rtl")):
            malformed = True
    if styles is not None:
        for properties, name in ((rpr, "rStyle"), (_single(paragraph._p, "pPr"), "pStyle")):
            style_id = _raw(_single(properties, name), "val")
            if style_id is not None and style_id not in style_ids:
                malformed = True
    if malformed:
        family, family_source = None, "unresolved"
        effective_size, size_source = None, "unresolved"
    return dict(run_index=index,
                font_family=_raw(fonts, "ascii") or _raw(fonts, "hAnsi"),
                font_size_pt=int(size) / 2 if size and re.fullmatch(r"[0-9]{1,10}", size) and int(size) > 0 else None,
                bold=_on_off(_children(rpr, "b")) if _children(rpr, "b") else None,
                italic=_on_off(_children(rpr, "i")) if _children(rpr, "i") else None,
                effective_family=family, effective_family_source=family_source,
                effective_size_pt=effective_size, effective_size_source=size_source)


def _extract_part(part, document, key, kind, styles, style_ids):
    flags = dict.fromkeys(_FLAGS, False)
    root = part.element
    # Inspect unsupported descendants, but never turn their text into paragraphs.
    for element in root.iter():
        flag = _SPECIAL.get(element.tag)
        if flag:
            flags[flag] = True
        for attr in (qn("r:id"), qn("r:embed"), qn("r:link")):
            rid = element.get(attr)
            if rid and rid in part.rels and part.rels[rid].is_external:
                flags["external_relationships"] = True
    paragraphs = []
    stack = []
    active_simple = []
    touched = {}

    def invalidate(reason):
        for field in stack + active_simple:
            if reason not in field["reasons"]:
                field["reasons"].append(reason)

    def unsupported(element, paragraph):
        flags[_SPECIAL.get(element.tag, "unsupported_containers")] = True
        paragraph["formatting"]["completeness"] = "unsupported"
        invalidate("unsupported_container")
        if any(node.tag in (qn("w:fldChar"), qn("w:fldSimple"), qn("w:instrText"))
               for node in element.iter()):
            flags["unsupported_fields"] = True

    def emit(text, paragraph):
        if not text:
            return
        fields = active_simple + stack
        if fields:
            for field in fields:
                touched.setdefault(id(field), set()).add(paragraph["paragraph_index"])
            # Text before a complex separator is not a visible cached result.
            if stack and not stack[-1]["_separated"]:
                invalidate("text_in_instruction")
                return
            paragraph["cached_text"] += text
            for field in fields:
                field["cached_result"] += text
        else:
            paragraph["literal_text"] += text
        paragraph["visible_text"] += text

    def walk(container, paragraph, para):
        for element in container:
            tag = element.tag
            if tag in (qn("w:pPr"), qn("w:rPr")):
                continue
            if tag == qn("w:hyperlink"):
                walk(element, paragraph, para)
            elif tag == qn("w:r"):
                hidden = _hidden(Run(element, para), para, styles)
                if hidden:
                    flags["hidden_text"] = True
                    unsupported(element, paragraph)
                    continue
                before = len(paragraph["visible_text"])
                walk(element, paragraph, para)
                if len(paragraph["visible_text"]) > before:
                    runs = paragraph["formatting"]["runs"]
                    runs.append(_format_run(element, para, len(runs), styles, style_ids))
            elif tag in _TEXT:
                emit(element.text or "" if _TEXT[tag] is None else _TEXT[tag], paragraph)
            elif tag == qn("w:fldSimple"):
                field = _new_field("simple", paragraph["paragraph_index"], _raw(element, "instr") or "")
                paragraph["fields"].append(field)
                if stack or active_simple:
                    invalidate("nested_field")
                    field["reasons"].append("nested_field")
                active_simple.append(field)
                walk(element, paragraph, para)
                active_simple.pop()
                _classify(field)
            elif tag == qn("w:instrText"):
                if stack and not stack[-1]["_separated"]:
                    stack[-1]["instruction"] += element.text or ""
                else:
                    field = _new_field("complex", paragraph["paragraph_index"], element.text or "")
                    field["reasons"].append("orphan_instruction")
                    paragraph["fields"].append(field)
                    invalidate("instruction_after_separator")
            elif tag == qn("w:fldChar"):
                typ = _raw(element, "fldCharType")
                if typ == "begin":
                    field = _new_field("complex", paragraph["paragraph_index"])
                    field["_separated"] = False
                    paragraph["fields"].append(field)
                    if stack or active_simple:
                        invalidate("nested_field")
                        field["reasons"].append("nested_field")
                    stack.append(field)
                elif typ in ("separate", "end") and stack:
                    field = stack[-1]
                    touched.setdefault(id(field), set()).add(paragraph["paragraph_index"])
                    if typ == "separate":
                        if field["_separated"]:
                            invalidate("duplicate_separator")
                        field["_separated"] = True
                    else:
                        if not field["_separated"]:
                            field["reasons"].append("missing_separator")
                        stack.pop()
                        _classify(field)
                else:
                    field = _new_field("complex", paragraph["paragraph_index"])
                    field["reasons"].append("orphan_or_invalid_field_marker")
                    paragraph["fields"].append(field)
                    invalidate("invalid_field_marker")
            elif tag in (qn("w:bookmarkStart"), qn("w:bookmarkEnd"), qn("w:proofErr")):
                continue
            else:
                unsupported(element, paragraph)

    for child in root:
        if child.tag != qn("w:p"):
            flags[_SPECIAL.get(child.tag, "unsupported_containers")] = True
            invalidate("unsupported_container")
            if any(node.tag in (qn("w:fldChar"), qn("w:fldSimple")) for node in child.iter()):
                flags["unsupported_fields"] = True
            continue
        ppr = _single(child, "pPr")
        paragraph = dict(paragraph_index=len(paragraphs), literal_text="", cached_text="",
                         visible_text="", fields=[], formatting=dict(
                             alignment=_raw(_single(ppr, "jc"), "val"),
                             completeness="complete", runs=[]))
        paragraphs.append(paragraph)
        if any(node.tag in _SPECIAL for node in child.iter()):
            paragraph["formatting"]["completeness"] = "unsupported"
        for field in stack:
            touched.setdefault(id(field), set()).add(paragraph["paragraph_index"])
        para = Paragraph(child, document)
        if _numbered(para, styles):
            flags["automatic_numbering"] = True
            paragraph["formatting"]["completeness"] = "unsupported"
        walk(child, paragraph, para)
        formatting = paragraph["formatting"]
        if (len(_children(child, "pPr")) > 1 or len(_children(ppr, "jc")) > 1
                or any(run["effective_family"] is None or run["effective_size_pt"] is None
                       for run in formatting["runs"])) and formatting["completeness"] == "complete":
            formatting["completeness"] = "unresolved"
    invalidate("missing_end")
    for paragraph in paragraphs:
        for field in paragraph["fields"]:
            field.pop("_separated", None)
            _classify(field)
            if field["status"] == "unresolved":
                flags["unsupported_fields"] = True
                for index in touched.get(id(field), set()) | {field["paragraph_index"]}:
                    if paragraphs[index]["formatting"]["completeness"] == "complete":
                        paragraphs[index]["formatting"]["completeness"] = "unresolved"
    return dict(part_key=key, kind=kind, consumers=[], paragraphs=paragraphs,
                unsupported_content=flags,
                completeness="unsupported" if any(flags.values()) else
                "unresolved" if any(p["formatting"]["completeness"] != "complete" for p in paragraphs)
                else "complete")


def extract_page_elements(document: Document) -> dict:
    """Return deterministic section/unique-story evidence without package mutation.

    Only direct story paragraphs and supported field/run containers are extracted.
    Unsupported content is retained as flags, not flattened or judged incorrect.
    Relationship failures are local unresolved evidence; programmer errors propagate.
    """
    sections, parts = [], []
    part_keys = {}
    settings, settings_status = _document_part_xml(document, RT.SETTINGS, "settings")
    styles, _ = _document_part_xml(document, RT.STYLES, "styles")
    style_ids = {style.get(qn("w:styleId")) for style in _children(styles, "style")}
    even = None if settings_status == "unresolved" else _on_off(_children(settings, "evenAndOddHeaders"))
    sects = [section._sectPr for section in document.sections]
    if not sects:
        sects = [None]
    for index, sect in enumerate(sects):
        reasons = []
        types = _children(sect, "type")
        raw_break = _raw(types[0], "val") if len(types) == 1 else None
        break_type = "nextPage" if not types and sect is not None else raw_break
        if len(types) > 1 or break_type not in _BREAKS:
            break_type = None
            reasons.append("unresolved_section_break")
        if sect is None or len(_children(document.element.body, "sectPr")) != 1 or not (
                sect.getparent() is document.element.body or
                (sect.getparent().tag == qn("w:pPr") and
                 len(_children(sect.getparent(), "sectPr")) == 1 and
                 len(_children(sect.getparent().getparent(), "pPr")) == 1 and
                 sect.getparent().getparent().getparent() is document.element.body)):
            reasons.append("unresolved_section_boundary")
        first = _on_off(_children(sect, "titlePg")) if sect is not None else None
        if first is None or even is None:
            reasons.append("unresolved_activation")
        references = {(kind, variant): [] for kind in _KINDS for variant in _VARIANTS}
        valid = {}
        for ref in (() if sect is None else sect):
            kind = "header" if ref.tag == qn("w:headerReference") else (
                "footer" if ref.tag == qn("w:footerReference") else None)
            if kind is None:
                continue
            variant = _raw(ref, "type")
            if variant not in _VARIANTS:
                reasons.append("unknown_story_variant")
                for candidate in _VARIANTS:
                    references[kind, candidate].append((None, "unknown_story_variant"))
                continue
            rid = ref.get(qn("r:id"))
            relationship = document.part.rels.get(rid)
            failure = None
            part = None
            if relationship is None:
                failure = "dangling_relationship"
            elif relationship.is_external:
                failure = "external_relationship"
            elif relationship.reltype != getattr(RT, kind.upper()):
                failure = "wrong_relationship_type"
            else:
                part = relationship.target_part
                root = getattr(part, "element", None)
                if root is None or root.tag != qn("w:hdr" if kind == "header" else "w:ftr"):
                    failure = "invalid_target_part"
            references[kind, variant].append((part, failure))
            if failure is None and part not in part_keys:
                key = len(parts)
                part_keys[part] = key
                parts.append(_extract_part(part, document, key, kind, styles, style_ids))
            if failure is None:
                valid[kind, variant] = part_keys[part]
        stories = []
        for kind in _KINDS:
            for variant in _VARIANTS:
                refs = references[kind, variant]
                activation_value = True if variant == "default" else first if variant == "first" else even
                story = dict(kind=kind, variant=variant, reference_state="absent",
                             linked_to_previous=False, source_section_index=None, part_key=None,
                             activation="unresolved" if activation_value is None else
                             "enabled" if activation_value else "disabled",
                             status="absent", reasons=[])
                if refs:
                    failures = [failure for _, failure in refs if failure]
                    if len(refs) != 1:
                        failures.append("duplicate_story_reference")
                    if failures:
                        story.update(reference_state="unresolved", status="unresolved", reasons=failures)
                    else:
                        story.update(reference_state="explicit", source_section_index=index,
                                     part_key=valid[kind, variant], status="resolved")
                elif index:
                    predecessor = next(s for s in sections[-1]["stories"]
                                       if s["kind"] == kind and s["variant"] == variant)
                    story.update(linked_to_previous=True,
                                 source_section_index=predecessor["source_section_index"],
                                 part_key=predecessor["part_key"], status=predecessor["status"])
                    if predecessor["status"] == "unresolved":
                        story["reasons"].append("unresolved_predecessor")
                if "unresolved_section_boundary" in reasons or "unknown_story_variant" in reasons:
                    story.update(status="unresolved")
                    story["reasons"].append("unresolved_section_evidence")
                if story["part_key"] is not None:
                    parts[story["part_key"]]["consumers"].append(
                        dict(section_index=index, kind=kind, variant=variant))
                stories.append(story)
        sections.append(dict(section_index=index, break_type=break_type, raw_break_type=raw_break,
                             first_page_enabled=first, even_pages_enabled=even,
                             numbering=_numbering(sect),
                             distances={kind: _distance(sect, kind) for kind in _KINDS},
                             stories=stories, status="unresolved" if reasons else "resolved",
                             reasons=reasons))
    return dict(sections=sections, parts=parts)
