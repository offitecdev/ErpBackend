"""
DIE ZWEI KENNZEICHEN DER KALENDER-MAILS (19.08.2026).

Jede Karte traegt oben ein Zeichen, das SOFORT sagt, worum es geht:
  * Termin   — ein Kalenderblatt
  * Aufgabe  — ein Haken im Kreis (dasselbe Zeichen, das die Aufgabe im
               Kalender als Merker traegt, siehe ChipLabel im Frontend)

Beide sind WEISS auf durchsichtigem Grund. Die Farbe kommt nicht aus dem Bild,
sondern aus der Flaeche darunter (`background-color` einer Tabellenzelle) — so
traegt dasselbe Bild das Marineblau des Termins, das Gruen der Aufgabe und das
Rot der Absage, ohne dass es drei Dateien braucht. `background-color` auf einer
Zelle ist das Einzige, worauf man sich in Outlook wirklich verlassen kann.

PNG statt SVG, weil Mailprogramme kein SVG darstellen (Outlook zeigt gar
keins). Gezeichnet wird vierfach vergroessert und dann verkleinert — PIL kennt
keine Kantenglaettung, das Verkleinern ist sie.

Erzeugen:
    python scripts/mail-kind-icons.py
Das Ergebnis wandert als Base64-Konstante nach
`src/infrastructure/services/mailKindIcons.ts`.
"""

import base64
import io
import os
from PIL import Image, ImageDraw

SIZE = 128
SS = 4  # Ueberabtastung
S = SIZE * SS
WHITE = (255, 255, 255, 255)
CLEAR = (255, 255, 255, 0)


def canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGBA", (S, S), CLEAR)
    return image, ImageDraw.Draw(image)


def finish(image: Image.Image) -> str:
    small = image.resize((SIZE, SIZE), Image.LANCZOS)
    buffer = io.BytesIO()
    small.save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def appointment() -> str:
    """Kalenderblatt: Rahmen, gefuellter Kopf, zwei Ringe, vier Tage."""
    image, draw = canvas()
    stroke = 9 * SS
    left, top, right, bottom = 13 * SS, 26 * SS, 115 * SS, 116 * SS
    radius = 14 * SS

    # Blattrand.
    draw.rounded_rectangle([left, top, right, bottom], radius=radius, outline=WHITE, width=stroke)
    # Kopfband — voll gefuellt, damit das Blatt auch bei 34 Punkten ein
    # Kalenderblatt bleibt und nicht bloss ein Kasten.
    draw.rounded_rectangle([left, top, right, top + 24 * SS], radius=radius, fill=WHITE)
    draw.rectangle([left, top + 12 * SS, right, top + 24 * SS], fill=WHITE)
    # Die zwei Ringe oben.
    for x in (41 * SS, 87 * SS):
        draw.rounded_rectangle(
            [x - 5 * SS, 10 * SS, x + 5 * SS, 34 * SS],
            radius=5 * SS,
            fill=WHITE,
        )
    # Tage: zwei Reihen zu drei Punkten.
    dot = 7 * SS
    for row in range(2):
        for col in range(3):
            cx = 36 * SS + col * 28 * SS
            cy = 70 * SS + row * 24 * SS
            draw.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=WHITE)
    return finish(image)


def task() -> str:
    """Haken im Kreis — dasselbe Zeichen wie der Merker im Kalender."""
    image, draw = canvas()
    stroke = 10 * SS
    inset = 12 * SS
    draw.ellipse([inset, inset, S - inset, S - inset], outline=WHITE, width=stroke)
    # Der Haken: drei Punkte, runde Enden (joint="curve" rundet die Ecke).
    points = [(40 * SS, 66 * SS), (57 * SS, 84 * SS), (90 * SS, 46 * SS)]
    draw.line(points, fill=WHITE, width=stroke, joint="curve")
    for x, y in points:
        r = stroke // 2
        draw.ellipse([x - r, y - r, x + r, y + r], fill=WHITE)
    return finish(image)


HEADER = '''import { BRAND_ICON_APPOINTMENT_CID, BRAND_ICON_TASK_CID } from "./mailBrand";

/**
 * DIE ZWEI KENNZEICHEN DER KALENDER-MAILS (19.08.2026) — als Base64.
 *
 * ERZEUGT von `scripts/mail-kind-icons.py`; von Hand geaendert wird hier
 * nichts. Beide Bilder sind WEISS auf durchsichtigem Grund: die Farbe kommt
 * aus der Flaeche darunter (Marineblau beim Termin, Gruen bei der Aufgabe,
 * Rot bei der Absage), damit ein Bild fuer alle Faelle reicht.
 */
'''

TEMPLATE = '''
{header}
const APPOINTMENT_PNG_BASE64 =
{appointment};

const TASK_PNG_BASE64 =
{task};

/** Inline-Bild fuer `SendMailInput.inlineImages`; im HTML per `cid:` einsetzen. */
export const kindIconInline = (kind: "APPOINTMENT" | "TASK") => (
    kind === "TASK"
        ? {{ cid: BRAND_ICON_TASK_CID, contentType: "image/png", contentBase64: TASK_PNG_BASE64 }}
        : {{ cid: BRAND_ICON_APPOINTMENT_CID, contentType: "image/png", contentBase64: APPOINTMENT_PNG_BASE64 }}
);
'''


def literal(value: str) -> str:
    """Base64 in Zeilen zu 118 Zeichen — sonst ist die Datei eine einzige Zeile."""
    chunks = [value[i:i + 118] for i in range(0, len(value), 118)]
    return " +\n".join(f'    "{chunk}"' for chunk in chunks)


def main() -> None:
    out = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "src", "infrastructure", "services", "mailKindIcons.ts",
    )
    body = TEMPLATE.format(
        header=HEADER,
        appointment=literal(appointment()),
        task=literal(task()),
    )
    with open(out, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(body.lstrip("\n"))
    print(f"geschrieben: {out}")


if __name__ == "__main__":
    main()
