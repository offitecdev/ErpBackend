const fs = require('fs');

const FILE = '.env';
const raw = fs.readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
let s = raw.split('\r\n').join('\n');

const OLD = `# Eine oeffentliche Adresse (cdn.offitec.ch o.ae.) braucht es erst, wenn
# Produktbilder dauerhaft im Programm haengen — 132 Bilder pro Seite einzeln
# zu presignen waere Verschwendung. Bis dahin liest sie niemand aus, darum
# steht sie ausgeschaltet da:
# OFFITEC_S3_PUBLIC_BASE_URL=https://cdn.offitec.ch`;

const NEW = `# OEFFENTLICHE ADRESSE (optional)
#
# Die Domain, die in Cloudflare an den Eimer gehaengt ist — entweder eine
# eigene (cdn.offitec.ch) oder die von Cloudflare vergebene r2.dev-Adresse.
# Zu finden unter: R2 -> der Eimer -> Settings -> Public access.
#
# OHNE Wert: alles wird presigniert (Adressen mit 15 Minuten Gueltigkeit).
# MIT Wert:  BILDER bekommen die feste, zwischenspeicherbare Adresse —
#            Angebotsbilder, Rapportfotos, Produktbilder, Unterschriften.
#            UNTERLAGEN nicht: Vertraege, Personalakten und Angebotsanhaenge
#            bleiben presigniert, sie sollen nicht offen im Netz liegen.
#
# ACHTUNG: In Cloudflare muss "Public access" fuer den Eimer wirklich
# eingeschaltet sein, sonst zeigen alle Bilder ins Leere. Der Pruefbefehl
# unten laedt testweise eine Datei ueber diese Adresse und sagt Bescheid.
# Wer die Adresse hat, kann die Datei lesen — eine Anmeldung gibt es dort
# nicht, und die Schluessel tragen die Mandanten-ID im Pfad.
#
# Ohne abschliessenden Schraegstrich eintragen, z.B. https://cdn.offitec.ch
OFFITEC_S3_PUBLIC_BASE_URL=`;

if (!s.includes(OLD)) { console.error('Muster nicht gefunden.'); process.exit(1); }
s = s.replace(OLD, NEW);

fs.writeFileSync(FILE, crlf ? s.split('\n').join('\r\n') : s);
console.log('OFFITEC_S3_PUBLIC_BASE_URL ist jetzt eine echte Variable (leer = ausgeschaltet).');
