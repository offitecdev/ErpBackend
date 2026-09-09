"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.denyTechnicianOnly = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const pageCatalog_1 = require("../../shared/pageCatalog");
/**
 * «Techniker legen keine Checklisten an — sie füllen sie nur aus oder sehen
 * sie an» (Vorgabe Samet, 02.09.2026).
 *
 * Die Rechte allein können das nicht entscheiden: `projects.view` ist das
 * Leserecht der Montage UND der Projektliste des Büros, eine Altrolle
 * «Techniker» trägt es also genauso wie ein Projektleiter (siehe die Notiz zum
 * Montage-Modul im Frontend, `lib/access.ts` → `isTechnicianRole`). Darum
 * entscheidet hier dasselbe wie dort — die STUFENKARTE der Rolle:
 *
 *   Eine Rolle ist eine Technikerrolle, wenn «Montage» ihre einzige
 *   Arbeitsfläche ist (Stempeluhr und eigene Anträge darf sie mittragen).
 *
 * Die Administratorrolle ist nie eine Technikerrolle. Eine Rolle ohne
 * gespeicherte Karte wird — wie überall im Server — aus ihren Rechten
 * zurückgerechnet, und weil `projects.view` dabei auch die Projektliste
 * öffnet, sieht so eine Altrolle nie nach «nur Montage» aus: sie darf hier
 * weiter anlegen. Das ist bewusst dieselbe Lücke wie im Frontend; dort deckt
 * sie der Name der Rolle ab, hier reicht der Zustand, weil der Montage-
 * Bildschirm einer solchen Rolle ohnehin keinen Anlegen-Knopf mehr zeigt.
 */
const MONTAGE_PAGE_KEY = 'montage.workspace';
const TECHNICIAN_COMPANION_PAGES = new Set(['personnel.terminal', 'personnel.requests', 'personnel.leaves']);
const isTechnicianOnly = (levels) => {
    const granted = Object.entries(levels).filter(([, level]) => level > 0).map(([key]) => key);
    if (!granted.includes(MONTAGE_PAGE_KEY))
        return false;
    return granted.every((key) => key === MONTAGE_PAGE_KEY || TECHNICIAN_COMPANION_PAGES.has(key));
};
/** Die Stufenkarte der (ersten) Rolle einer Person — leer, wenn sie keine hat. */
const levelsForEmployee = async (employeeId) => {
    const assignment = await prisma_client_1.default.employeeRole.findFirst({
        where: { employeeId },
        select: {
            role: {
                select: {
                    isSystemAdmin: true,
                    pageLevels: true,
                    permissions: { select: { permission: { select: { permissionName: true } } } },
                },
            },
        },
    });
    const role = assignment?.role;
    if (!role)
        return {};
    if (role.isSystemAdmin)
        return { ...pageCatalog_1.ADMIN_PAGE_LEVELS };
    if (role.pageLevels && typeof role.pageLevels === 'object')
        return (0, pageCatalog_1.sanitizePageLevels)(role.pageLevels);
    return (0, pageCatalog_1.pageLevelsFromPermissions)(role.permissions.map((entry) => entry.permission.permissionName));
};
const denyTechnicianOnly = async (req, res, next) => {
    try {
        if (!req.user) {
            res.status(401).json({ error: 'Anmeldung erforderlich.' });
            return;
        }
        const levels = await levelsForEmployee(req.user.id);
        if (isTechnicianOnly(levels)) {
            res.status(403).json({ error: 'Checklisten werden im Büro angelegt — auf dem Montage-Bildschirm werden sie nur ausgefüllt.' });
            return;
        }
        next();
    }
    catch (error) {
        console.error('[TechnicianGuard] Stufenkarte konnte nicht gelesen werden:', error);
        res.status(500).json({ error: 'Berechtigung konnte nicht geprüft werden.' });
    }
};
exports.denyTechnicianOnly = denyTechnicianOnly;
//# sourceMappingURL=TechnicianGuard.js.map