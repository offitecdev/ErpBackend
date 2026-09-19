"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const documentGovernance_1 = require("../../shared/documentGovernance");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
/**
 * ── /document-events — DER VERLAUF EINES BELEGS (16.09.2026, Schritt 4 / D1) ─
 *
 *   GET /?entityType=PROJECT&entityId=…          die Einträge, neueste zuerst
 *   GET /summary?entityType=PROJECT&entityId=…   Anzahl + Anzahl Eingriffe
 *
 * Nur lesen — Einträge entstehen ausschliesslich in den Handlungen selbst und
 * werden nie geändert oder gelöscht. Wer irgendeinen Verkaufs-, Projekt- oder
 * Rechnungsbeleg sehen darf, sieht auch seinen Verlauf; der Mandant grenzt ab.
 */
const router = (0, express_1.Router)();
router.use(AuthMiddleware_1.requireAuth);
const READ_PERMISSIONS = ['tenders.view', 'billing.view', 'projects.view', 'crm.customers.view'];
const parseTarget = (req) => {
    const entityType = String(req.query.entityType || '').trim().toUpperCase();
    const entityId = String(req.query.entityId || '').trim();
    if (!documentGovernance_1.DOCUMENT_ENTITY_TYPES.includes(entityType) || !entityId || entityId.length > 191)
        return null;
    return { entityType, entityId };
};
router.get('/', (0, RbacMiddleware_1.requireAnyPermission)(READ_PERMISSIONS), async (req, res) => {
    try {
        const target = parseTarget(req);
        if (!target)
            return res.status(400).json({ error: 'Beleg fehlt oder ist unbekannt.' });
        const items = await (0, documentGovernance_1.loadDocumentHistory)(prisma_client_1.default, { tenantId: req.user.tenantId, ...target });
        res.status(200).json({ items });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.get('/summary', (0, RbacMiddleware_1.requireAnyPermission)(READ_PERMISSIONS), async (req, res) => {
    try {
        const target = parseTarget(req);
        if (!target)
            return res.status(400).json({ error: 'Beleg fehlt oder ist unbekannt.' });
        const summary = await (0, documentGovernance_1.loadDocumentHistorySummary)(prisma_client_1.default, { tenantId: req.user.tenantId, ...target });
        res.status(200).json(summary);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=documentEvents.routes.js.map