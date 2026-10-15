"""Builds tiny PDFs in memory so tests don't depend on files lying around."""


def _pdf(objs: list[bytes]) -> bytes:
    out, offsets = b"%PDF-1.4\n", []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\n".encode()
    out += f"startxref\n{xref}\n%%EOF\n".encode()
    return out


def text_pdf(lines: list[str]) -> bytes:
    """One page with a real text layer, like a PDF exported from Word."""
    content = "BT /F1 14 Tf 50 750 Td " + " ".join(f"({line}) Tj 0 -20 Td" for line in lines)
    content += " ET"
    return _pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
            b"/Resources << /Font << /F1 5 0 R >> >> >>",
            f"<< /Length {len(content)} >>\nstream\n{content}\nendstream".encode(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ]
    )


def image_only_pdf() -> bytes:
    """One gray image and no text layer, like a scanned slide."""
    img = b"\x80" * (100 * 100)
    return _pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
            b"/Resources << /XObject << /Im1 5 0 R >> >> >>",
            b"<< /Length 35 >>\nstream\nq 300 0 0 300 150 400 cm /Im1 Do Q\nendstream",
            b"<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceGray "
            b"/BitsPerComponent 8 /Length 10000 >>\nstream\n" + img + b"\nendstream",
        ]
    )


CORRUPTED = b"%PDF-1.4\nthis is not really a pdf, the bytes after the header are garbage\n"
