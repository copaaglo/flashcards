"""Writes deploy/helm/flashcards/files/smoke.pdf, the tiny lecture the smoke test uploads.

Standard library only, so it runs anywhere. Run it from the repo root:
    python3 scripts/make-smoke-pdf.py
"""

lines = [
    "Smoke test lecture: The Water Cycle",
    "",
    "Evaporation: the sun heats water in oceans, lakes and rivers and turns it into water vapour.",
    "Transpiration: plants release water vapour from their leaves into the air.",
    "Condensation: as vapour rises it cools and forms tiny droplets, which make clouds.",
    "Precipitation: when droplets combine and grow heavy they fall as rain, snow, sleet or hail.",
    "Collection: water gathers in oceans, lakes, rivers and underground aquifers.",
    "Infiltration: some water soaks into the soil and becomes groundwater.",
    "Runoff: water that does not soak in flows over land into streams and rivers.",
    "The cycle is driven by energy from the sun and by gravity, and it has no start or end.",
]
text_ops = ["BT", "/F1 11 Tf", "14 TL", "72 740 Td"]
for line in lines:
    safe = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    text_ops.append(f"({safe}) Tj T*")
text_ops.append("ET")
stream = "\n".join(text_ops).encode("ascii")

objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
    b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
]
out = bytearray(b"%PDF-1.4\n")
offsets = []
for number, body in enumerate(objects, start=1):
    offsets.append(len(out))
    out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
xref = len(out)
out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
for offset in offsets:
    out += f"{offset:010d} 00000 n \n".encode()
out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()

with open("deploy/helm/flashcards/files/smoke.pdf", "wb") as f:
    f.write(out)
print(f"Wrote deploy/helm/flashcards/files/smoke.pdf ({len(out)} bytes)")
