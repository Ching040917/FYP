"""Fail-closed semantic package comparison for verified guided DOCX corrections.

Only selected direct-format attributes in top-level document paragraphs may differ.
Everything else, including unknown XML and non-XML parts, must survive intact.
"""

import io
import posixpath
import zipfile
from urllib.parse import unquote, urlsplit

from lxml import etree

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_R = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_DCTERMS = "{http://purl.org/dc/terms/}"
_EP = "{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}"
_MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
_XSI = "{http://www.w3.org/2001/XMLSchema-instance}"

# The selected rule never licenses a change to a sibling attribute on the
# same element (e.g. spacing/@after while correcting spacing/@before).
_PROPERTIES = {
    "FONT_CONSISTENCY": ("rPr", "rFonts", ("ascii", "hAnsi", "eastAsia")),
    "FONT_SIZE": ("rPr", "sz", ("val",)),
    "ALIGNMENT": ("pPr", "jc", ("val",)),
    "LINE_SPACING": ("pPr", "spacing", ("line", "lineRule")),
    "SPACE_BEFORE": ("pPr", "spacing", ("before",)),
    "SPACE_AFTER": ("pPr", "spacing", ("after",)),
}
_CORE_SAVE_FIELDS = {_DCTERMS + "modified"}
_APP_SAVE_FIELDS = {
    _EP + name for name in (
        "TotalTime", "Pages", "Words", "Characters", "CharactersWithSpaces",
        "Lines", "Paragraphs",
    )
}
_REQUIRED = {
    "[Content_Types].xml", "_rels/.rels", "word/document.xml",
    "word/_rels/document.xml.rels", "word/styles.xml", "word/settings.xml",
}

_MAX_EXPANDED_PART = 32 * 1024 * 1024
_MAX_EXPANDED_TOTAL = 64 * 1024 * 1024
_MAX_PARTS = 4096


def _package(data: bytes) -> dict[str, bytes]:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            if len(infos) > _MAX_PARTS:
                raise ValueError("DOCX contains too many parts")
            names = [entry.filename for entry in infos]
            if len(names) != len(set(names)):
                raise ValueError("duplicate DOCX ZIP entry")
            if any(
                entry.is_dir() or name.startswith("/") or "\\" in name
                or any(part in ("", ".", "..") for part in name.split("/"))
                for name, entry in zip(names, infos)
            ):
                raise ValueError("invalid DOCX ZIP path")
            if not _REQUIRED.issubset(names):
                raise ValueError("missing required DOCX part")
            if any(entry.file_size > _MAX_EXPANDED_PART for entry in infos):
                raise ValueError("DOCX part exceeds expanded-size boundary")
            if sum(entry.file_size for entry in infos) > _MAX_EXPANDED_TOTAL:
                raise ValueError("DOCX exceeds expanded-size boundary")
            parts = {}
            remaining = _MAX_EXPANDED_TOTAL
            for entry in infos:
                with archive.open(entry) as stream:
                    content = stream.read(min(_MAX_EXPANDED_PART, remaining) + 1)
                if len(content) > _MAX_EXPANDED_PART or len(content) > remaining:
                    raise ValueError("DOCX exceeds expanded-size boundary")
                parts[entry.filename] = content
                remaining -= len(content)
    except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
        raise ValueError("invalid DOCX ZIP archive") from exc
    return parts

def validate_package(data: bytes) -> None:
    """Reject malformed or over-expanded uploads before python-docx parses them."""
    _package(data)


def _xml(data: bytes):
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("DOCX XML cannot contain DTD or entities")
    try:
        root = etree.fromstring(data, etree.XMLParser(
            resolve_entities=False, load_dtd=False, no_network=True,
            remove_blank_text=False, remove_comments=False, remove_pis=False,
            huge_tree=False,
        ))
        if root.getroottree().docinfo.doctype:
            raise ValueError("DOCX XML cannot contain a DTD")
        return root
    except etree.XMLSyntaxError as exc:
        raise ValueError("malformed DOCX XML") from exc


def _check_relationships(parts: dict[str, bytes]) -> None:
    for name, data in parts.items():
        if not name.endswith(".rels"):
            continue
        if not (name == "_rels/.rels" or "/_rels/" in name):
            raise ValueError("invalid relationship part path")
        root = _xml(data)
        if root.tag != _R + "Relationships":
            raise ValueError("invalid relationship XML")
        base = "" if name == "_rels/.rels" else name.replace("/_rels/", "/").removesuffix(".rels")
        seen = set()
        for relation in root:
            if relation.tag != _R + "Relationship" or len(relation):
                raise ValueError("invalid relationship element")
            relation_id = relation.get("Id")
            target = relation.get("Target")
            if not relation_id or relation_id in seen or not relation.get("Type") or not target:
                raise ValueError("invalid or duplicate relationship")
            seen.add(relation_id)
            mode = relation.get("TargetMode", "Internal")
            if mode not in ("Internal", "External"):
                raise ValueError("invalid relationship target mode")
            if mode == "External":
                continue
            uri = urlsplit(target)
            if uri.scheme or uri.netloc or uri.query or "\\" in target:
                raise ValueError("invalid internal relationship target")
            path = unquote(uri.path)
            resolved = posixpath.normpath(
                path.lstrip("/") if path.startswith("/") else posixpath.join(posixpath.dirname(base), path)
            )
            if resolved.startswith("../") or resolved not in parts:
                raise ValueError("dangling internal relationship")


def _top_level_paragraphs(root):
    bodies = root.findall(_W + "body")
    if root.tag != _W + "document" or len(bodies) != 1:
        raise ValueError("invalid document XML")
    return [node for node in bodies[0] if node.tag == _W + "p"]


def _remove_property(node, parent_name: str, property_name: str, attributes: tuple[str, ...]):
    parents = node.findall(_W + parent_name)
    if len(parents) > 1:
        raise ValueError("ambiguous guided fix property container")
    if not parents:
        return
    parent = parents[0]
    properties = parent.findall(_W + property_name)
    if len(properties) > 1:
        raise ValueError("ambiguous guided fix property")
    if not properties:
        return
    prop = properties[0]
    for name in attributes:
        prop.attrib.pop(_W + name, None)
    # Empty formatting containers created by python-docx are equivalent to
    # absent containers, but only on the explicitly selected target chain.
    if not len(prop) and not prop.attrib and not prop.text and not prop.tail:
        parent.remove(prop)
    if not len(parent) and not parent.attrib and not parent.text and not parent.tail:
        node.remove(parent)


def _mask_document(root, targets):
    paragraphs = _top_level_paragraphs(root)
    for paragraph_index, run_index, rule in targets:
        if paragraph_index < 0 or paragraph_index >= len(paragraphs):
            raise ValueError("guided fix paragraph target missing")
        paragraph = paragraphs[paragraph_index]
        parent, prop, attributes = _PROPERTIES[rule]
        if run_index is None:
            _remove_property(paragraph, parent, prop, attributes)
            continue
        # python-docx Paragraph.runs exposes only direct w:r children. An
        # indirect run (hyperlink, revision, wrapper) makes mapping ambiguous.
        runs = [child for child in paragraph if child.tag == _W + "r"]
        if len(runs) != len(paragraph.findall(".//" + _W + "r")):
            raise ValueError("ambiguous guided fix run traversal")
        if run_index < 0 or run_index >= len(runs):
            raise ValueError("guided fix run target missing")
        _remove_property(runs[run_index], parent, prop, attributes)


def _qname_value(value, node):
    prefix, separator, local = value.partition(":")
    if separator:
        namespace = node.nsmap.get(prefix)
        if namespace is None:
            raise ValueError("unbound QName in compatibility metadata")
        return "{" + namespace + "}" + local
    namespace = node.nsmap.get(value)
    if namespace is None:
        raise ValueError("unbound namespace prefix in compatibility metadata")
    return namespace


def _tree(node):
    if isinstance(node, etree._ProcessingInstruction):
        return ("processing-instruction", node.target, node.text, node.tail)
    if isinstance(node, etree._Comment):
        return ("comment", node.text, node.tail)
    attrs = dict(node.attrib)
    for name in (_MC + "Ignorable", _MC + "MustUnderstand", _MC + "PreserveElements",
                 _MC + "PreserveAttributes", _MC + "ProcessContent"):
        if name in attrs:
            attrs[name] = tuple(sorted(_qname_value(item, node) for item in attrs[name].split()))
    if _XSI + "type" in attrs:
        attrs[_XSI + "type"] = _qname_value(attrs[_XSI + "type"], node)
    return (node.tag, tuple(sorted(attrs.items())), node.text, node.tail,
            tuple(_tree(child) for child in node))


def _outer_nodes(root):
    preceding = []
    node = root.getprevious()
    while node is not None:
        preceding.append(_tree(node))
        node = node.getprevious()
    following = []
    node = root.getnext()
    while node is not None:
        following.append(_tree(node))
        node = node.getnext()
    return tuple(reversed(preceding)), tuple(following)


def _semantic_xml(name, source, output, targets):
    before, after = _xml(source), _xml(output)
    if _outer_nodes(before) != _outer_nodes(after):
        raise ValueError(f"unauthorized DOCX processing instruction in {name}")
    if name == "word/document.xml":
        _mask_document(before, targets)
        _mask_document(after, targets)
    elif name == "docProps/core.xml" or name == "docProps/app.xml":
        allowed = _CORE_SAVE_FIELDS if name == "docProps/core.xml" else _APP_SAVE_FIELDS
        if before.tag != after.tag:
            raise ValueError("document metadata root changed")
        for root in (before, after):
            for child in root:
                if child.tag in allowed:
                    if len(child):
                        raise ValueError("complex save metadata cannot be ignored")
                    child.text = None
    elif name.endswith(".rels"):
        if before.tag != after.tag:
            raise ValueError("relationship root changed")
        # OPC relationship order carries no semantics; IDs/targets do.
        for root in (before, after):
            root[:] = sorted(root, key=lambda child: child.get("Id", ""))
    if _tree(before) != _tree(after):
        raise ValueError(f"unauthorized DOCX change in {name}")


def compare_preservation(source_bytes: bytes, output_bytes: bytes, allowed_targets: set[tuple[int, int | None, str]]) -> None:
    """Raise ValueError if a DOCX differs beyond precisely authorized formatting.

    `allowed_targets` contains zero-based (paragraph_index, run_index|None,
    rule_code) tuples. Both archives are independently validated; source
    bytes are never persisted or modified.
    """
    targets = set()
    for entry in allowed_targets:
        if not isinstance(entry, tuple) or len(entry) != 3:
            raise ValueError("invalid guided fix target")
        paragraph, run, rule = entry
        if (type(paragraph) is not int or paragraph < 0 or
                (run is not None and (type(run) is not int or run < 0)) or
                rule not in _PROPERTIES or
                (run is None) != (rule not in ("FONT_SIZE", "FONT_CONSISTENCY")) or
                entry in targets):
            raise ValueError("invalid or duplicate guided fix target")
        targets.add(entry)
    source = _package(source_bytes)
    output = _package(output_bytes)
    if source.keys() != output.keys():
        raise ValueError("DOCX package part inventory changed")
    _check_relationships(source)
    _check_relationships(output)
    # Always validate document target mapping even if an archive's document
    # bytes happen to match (a no-op is not evidence that a target existed).
    for package in (source, output):
        _mask_document(_xml(package["word/document.xml"]), targets)
    for name in source:
        if name.endswith((".xml", ".rels")) or name == "[Content_Types].xml":
            _semantic_xml(name, source[name], output[name], targets)
        elif source[name] != output[name]:
            raise ValueError(f"unauthorized DOCX binary part change in {name}")
