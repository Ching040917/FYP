"""bbox-fixture-1 ground-truth generator v2 (INDEPENDENT implementation).

Separate code path (pypdf raw content-stream parsing WITH recursive Form
XObject expansion) — never the pdfjs-based mapper:

- FIGURES: image paint ops (cm/Do) -> transformed unit-square corners ->
  axis-aligned page-space bbox.
- TABLES with visible borders: stroke segments (m/l/S) -> outer frame
  rectangle = the table's visible boundary.

Output: normalized bottom-left-origin 0..1 bboxes + expected classification.
Writes: tests/fixtures/bbox-fixture-1-expected.json
"""
import json
import re
import zlib
from pathlib import Path

from pypdf import PdfReader

OUT = Path(__file__).resolve().parent
PDF = OUT / "bbox-fixture-1.pdf"
PAGE_W, PAGE_H = 612.0, 792.0

_TOKEN_RE = re.compile(r"/[\/A-Za-z0-9]+|-?\d+(?:\.\d+)?|[A-Za-z*'\"]+")


def _decompress(data):
    try:
        return zlib.decompress(data)
    except Exception:
        return data


def _tokens_from(data):
    text = _decompress(data).decode("latin-1")
    text = re.sub(r"\((?:\\.|[^\\()])*\)", "()", text)
    text = re.sub(r"<[0-9a-fA-F\s]*>", "<hx>", text)
    return _TOKEN_RE.findall(text)


def _collect_streams(page, reader, seen=None):
    """Page content stream + recursively expanded Form XObject streams."""
    seen = seen or set()
    streams = []
    c = page.get_contents()
    if c is not None:
        streams.append(c.get_data())
    res = page.get("/Resources")
    xobjs = res.get("/XObject") if res else None
    if xobjs:
        for name in xobjs.keys():
            obj = xobjs[name]
            ref = obj.get_object() if hasattr(obj, "get_object") else obj
            oid = getattr(obj, "idnum", None) or id(obj)
            if oid in seen:
                continue
            seen.add(oid)
            if isinstance(ref, dict) and ref.get("/Subtype") == "/Form":
                inner = ref.get("/FormType")
                sub = ref.get("/Resources")
                streams.append(ref.get_data() if hasattr(ref, "get_data") else ref.get("/DecodedStream") or b"")
                if sub:
                    fake = type("F", (), {"get": lambda self, k, d=None: sub.get(k, d), "get_contents": lambda self: type("C", (), {"get_data": lambda: b""})()})()
                    streams.extend(_collect_streams(fake, reader, seen))
    return streams


def _parse_streams(streams):
    """Postfix CTM parser over concatenated streams. Returns (images, segs)."""
    tokens = []
    for s in streams:
        tokens.extend(_tokens_from(s))
    ctm = [1, 0, 0, 1, 0, 0]
    stack = []
    images = []
    segs = []
    pen = None
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t == "q":
            stack.append(ctm[:])
        elif t == "Q":
            if stack:
                ctm = stack.pop()
        elif t == "cm":
            vals = [float(x) for x in tokens[i - 6 : i]]
            a1, b1, c1, d1, e1, f1 = ctm
            a2, b2, c2, d2, e2, f2 = vals
            ctm = [a1 * a2 + b1 * c2, a1 * b2 + b1 * d2, c1 * a2 + d1 * c2, c1 * b2 + d1 * d2, e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2]
        elif t == "Do":
            a, b, c, d, e, f = ctm
            pts = [(a * x + c * y + e, b * x + d * y + f) for x, y in [(0, 0), (1, 0), (0, 1), (1, 1)]]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            images.append((min(xs), min(ys), max(xs), max(ys)))
        elif t in ("m", "l"):
            if len(tokens) - i >= 2:
                x, y = float(tokens[i - 2]), float(tokens[i - 1])
                if t == "m":
                    pen = (x, y)
                elif pen is not None:
                    segs.append((pen[0], pen[1], x, y))
                    pen = (x, y)
        elif t == "S":
            pass  # stroke marker (segment recorded at l)
        i += 1
    return images, segs


def main():
    reader = PdfReader(str(PDF))
    print("pages:", len(reader.pages))
    expected = {"figures": [], "tables": []}
    for pn, page in enumerate(reader.pages, 1):
        streams = _collect_streams(page, reader)
        images, segs = _parse_streams(streams)
        # figures: skip tiny repeated header logo (18x13.7)
        for (x0, y0, x1, y1) in images:
            w, h = x1 - x0, y1 - y0
            if w < 40 or h < 40:
                continue
            expected["figures"].append({
                "page": pn,
                "bbox": {"x": x0 / PAGE_W, "y": y0 / PAGE_H, "width": w / PAGE_W, "height": h / PAGE_H},
                "classification": "exact",
                "evidence": "pypdf-image-op",
            })
        h_ys_all = sorted({round(s[1], 1) for s in segs if abs(s[3] - s[1]) < 0.01})
        v_xs = sorted({round(s[0], 1) for s in segs if abs(s[2] - s[0]) < 0.01})
        # cluster horizontal lines: a table's rows are evenly spaced; a gap
        # > 1.5x the median row pitch separates ADJACENT tables (which share
        # x-ranges on the same page)
        groups = []
        if h_ys_all:
            gaps = [b - a for a, b in zip(h_ys_all, h_ys_all[1:])]
            median = sorted(gaps)[len(gaps) // 2] if gaps else 0
            threshold = max(median * 1.5, 10)
            group = [h_ys_all[0]]
            for y in h_ys_all[1:]:
                if y - group[-1] > threshold:
                    groups.append(group)
                    group = [y]
                else:
                    group.append(y)
            groups.append(group)
        for h_ys in groups:
            if len(h_ys) < 2 or len(v_xs) < 2:
                continue
            # frame y-extent from VERTICAL segments (they span the table
            # top-to-bottom). Cluster segments whose y-ranges are adjacent;
            # adjacent tables sharing x are separated by their y intervals.
            v_segs_sorted = sorted(
                [(min(s[1], s[3]), max(s[1], s[3])) for s in segs if abs(s[2] - s[0]) < 0.01],
                key=lambda r: r[0],
            )
            v_groups = []
            for (a, b) in v_segs_sorted:
                if v_groups and a - v_groups[-1][1] <= 5:
                    v_groups[-1] = (v_groups[-1][0], max(v_groups[-1][1], b))
                else:
                    v_groups.append((a, b))
            # pick the vertical group overlapping this horizontal group
            match = None
            for (a, b) in v_groups:
                if a <= h_ys[-1] + 5 and b >= h_ys[0] - 5:
                    match = (a, b)
                    break
            if not match:
                continue
            f = (min(v_xs), match[0], max(v_xs), match[1])
            expected["tables"].append({
                "page": pn,
                "bbox": {"x": f[0] / PAGE_W, "y": f[1] / PAGE_H, "width": (f[2] - f[0]) / PAGE_W, "height": (f[3] - f[1]) / PAGE_H},
                "classification": "exact",
                "evidence": "pypdf-border-frame",
                "h_lines": len(h_ys),
                "v_lines": len(v_xs),
            })
        print(f"page {pn}: images={len(images)} segs={len(segs)} hGroups={len(groups)} v={len(v_xs)}")

    # ---- identity assignment (fixture structure known) ----
    # figures on page 2 by SIZE FINGERPRINT: 216x162 -> figure 1,
    # 144x108 -> figure 2, ~133.7 square (rotated 45deg) -> figure 3
    for f in expected["figures"]:
        if f["page"] != 2:
            continue
        w = f["bbox"]["width"] * PAGE_W
        h = f["bbox"]["height"] * PAGE_H
        if abs(w - 216) < 2 and abs(h - 162) < 2:
            f["index"] = 1
        elif abs(w - 144) < 2 and abs(h - 108) < 2:
            f["index"] = 2
        elif abs(w - h) < 2 and abs(w - 133.7) < 3:
            f["index"] = 3
        else:
            f.pop("index", None)  # decorative icon / unknown: no identity
    # tables: page1 frames top->bottom = table 0 (A), table 2 (C);
    # bottom-left origin: larger y = higher on the page
    p1 = sorted([t for t in expected["tables"] if t["page"] == 1], key=lambda t: -t["bbox"]["y"])
    for rank, t in enumerate(p1):
        t["index"] = [0, 2][rank]
    for t in expected["tables"]:
        if t["page"] in (3, 4):
            t["index"] = 3

    out = OUT / "bbox-fixture-1-expected.json"
    out.write_text(json.dumps(expected, indent=1))
    print("figures:", [(f.get("index"), f["page"], round(f["bbox"]["width"], 1)) for f in expected["figures"]])
    print("tables:", [(t.get("index"), t["page"], round(t["bbox"]["width"], 1), round(t["bbox"]["height"], 1), t["h_lines"], t["v_lines"]) for t in expected["tables"]])
    print("written", out.name)


if __name__ == "__main__":
    main()
