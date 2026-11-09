"""Generate test files for Phase 1 input-validation tests (section 2).

Usage, from anywhere:
    python3 scripts/make-fixtures.py    # writes into fixtures/ at the repo root (gitignored)
"""

import os
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "fixtures"
OUT.mkdir(exist_ok=True)
MB = 1024 * 1024


def write(name, data):
    (OUT / name).write_bytes(data)
    print(f"{name:<22} {len(data):>12,} bytes")


# 2.1 Non-PDF: a real (tiny) JPEG and a zip, both should get 400
write(
    "not_a_pdf.jpg",
    bytes.fromhex(
        "ffd8ffe000104a46494600010100000100010000ffdb004300"
        + "08" * 64
        + "ffc0000b080001000101011100ffc4001400010000000000000000000000000000000affc40014"
        "1001000000000000000000000000000000ffda0008010100003f00d2cf20ffd9"
    ),
)
write("not_a_pdf.zip", b"PK\x05\x06" + b"\x00" * 18)  # valid empty zip

# 2.2 Fake extension: text file named .pdf, should get 400
write("fake.pdf", b"hello, I am definitely a PDF\n")

# 2.3 Empty file, should get 400
write("empty.pdf", b"")

# 2.5 Over the API limit (20 MB) but under nginx (25 MB): API returns 413 JSON
write("too_big_21mb.pdf", b"%PDF-1.4\n" + os.urandom(21 * MB))

# 2.6 Over the nginx limit (25 MB): nginx returns 413 before the API sees it
write("too_big_30mb.pdf", b"%PDF-1.4\n" + os.urandom(30 * MB))
