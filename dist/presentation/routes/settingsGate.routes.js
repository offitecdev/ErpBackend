"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
/* IT-Schleuse für heikle Einstellungsseiten (E-Mail-Einstellungen,
   Firmen-/Mandantenverwaltung): die Seite öffnet erst nach Eingabe des
   IT-Kennworts. Das ist eine ZUSÄTZLICHE Hürde über der normalen
   Berechtigung — gedacht als "nur die IT-Administration kennt es", nicht als
   kryptografische Sicherung.

   Das Kennwort steht in OFFITEC_IT_GATE_PASSWORD (Voreinstellung wie vom
   Auftraggeber genannt) und wird NUR hier auf dem Server geprüft — es steht
   nirgends im ausgelieferten Frontend-Code. */
const router = (0, express_1.Router)();
const GATE_PASSWORD = process.env.OFFITEC_IT_GATE_PASSWORD || '162627';
/* Grober Schutz gegen Durchprobieren: je Person höchstens 5 Fehlversuche pro
   5 Minuten. Bewusst im Speicher — ein Neustart setzt die Zähler zurück, das
   ist für diese Schleuse verschmerzbar. */
const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const attempts = new Map();
const tooManyAttempts = (employeeId) => {
    const now = Date.now();
    const entry = attempts.get(employeeId);
    if (!entry || now - entry.windowStart > WINDOW_MS) {
        attempts.set(employeeId, { count: 1, windowStart: now });
        return false;
    }
    entry.count += 1;
    return entry.count > MAX_ATTEMPTS;
};
// POST /settings/it-gate/verify — { password } → 204 bei Erfolg.
router.post('/it-gate/verify', AuthMiddleware_1.requireAuth, (req, res) => {
    const user = req.user;
    if (tooManyAttempts(user.id)) {
        return res.status(429).json({ error: 'Zu viele Versuche — bitte einige Minuten warten.' });
    }
    const password = String(req.body?.password || '');
    if (password !== GATE_PASSWORD) {
        return res.status(403).json({ error: 'Falsches Kennwort.' });
    }
    attempts.delete(user.id);
    res.status(204).send();
});
exports.default = router;
//# sourceMappingURL=settingsGate.routes.js.map