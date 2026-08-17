import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { IT_GATE_PASSWORD, issueItGateTicket } from '../middlewares/ItGateMiddleware';

/* IT-Schleuse für heikle Einstellungsseiten (E-Mail-Einstellungen,
   Firmen-/Mandantenverwaltung): die Seite öffnet erst nach Eingabe des
   IT-Kennworts. Das ist eine ZUSÄTZLICHE Hürde über der normalen
   Berechtigung — gedacht als "nur die IT-Administration kennt es", nicht als
   kryptografische Sicherung.

   Das Kennwort steht in OFFITEC_IT_GATE_PASSWORD (Voreinstellung wie vom
   Auftraggeber genannt) und wird NUR hier auf dem Server geprüft — es steht
   nirgends im ausgelieferten Frontend-Code.

   Seit dem Produkt-Upload (17.08.2026) gibt die Prüfung zusätzlich einen
   kurzlebigen Ausweis zurück (ItGateMiddleware): Seiten OHNE zweite
   Berechtigungsprüfung dahinter — der Upload ist die erste — weisen ihn bei
   jedem Aufruf vor, damit die Schleuse nicht bloss Anzeige bleibt. */

const router = Router();

const GATE_PASSWORD = IT_GATE_PASSWORD;

/* Grober Schutz gegen Durchprobieren: je Person höchstens 5 Fehlversuche pro
   5 Minuten. Bewusst im Speicher — ein Neustart setzt die Zähler zurück, das
   ist für diese Schleuse verschmerzbar. */
const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const attempts = new Map<string, { count: number; windowStart: number }>();

const tooManyAttempts = (employeeId: string): boolean => {
    const now = Date.now();
    const entry = attempts.get(employeeId);
    if (!entry || now - entry.windowStart > WINDOW_MS) {
        attempts.set(employeeId, { count: 1, windowStart: now });
        return false;
    }
    entry.count += 1;
    return entry.count > MAX_ATTEMPTS;
};

/* POST /settings/it-gate/verify — { password } → { ticket, expiresAt }.
   Die Antwort trug früher keinen Inhalt (204); die aufrufende Seite wertet den
   Erfolg weiterhin am Status aus, legt den Ausweis aber für die
   Upload-Aufrufe beiseite. */
router.post('/it-gate/verify', requireAuth, (req, res) => {
    const user = req.user!;
    if (tooManyAttempts(user.id)) {
        return res.status(429).json({ error: 'Zu viele Versuche — bitte einige Minuten warten.' });
    }
    const password = String(req.body?.password || '');
    if (password !== GATE_PASSWORD) {
        return res.status(403).json({ error: 'Falsches Kennwort.' });
    }
    attempts.delete(user.id);
    res.status(200).json(issueItGateTicket(user.id));
});

export default router;
