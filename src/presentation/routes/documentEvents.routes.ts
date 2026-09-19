import { Request, Response, Router } from 'express';

import prisma from '../../infrastructure/database/prisma.client';
import {
    DOCUMENT_ENTITY_TYPES,
    loadDocumentHistory,
    loadDocumentHistorySummary,
    type DocumentEntityType,
} from '../../shared/documentGovernance';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission } from '../middlewares/RbacMiddleware';

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
const router = Router();
router.use(requireAuth);

const READ_PERMISSIONS = ['tenders.view', 'billing.view', 'projects.view', 'crm.customers.view'];

const parseTarget = (req: Request): { entityType: DocumentEntityType; entityId: string } | null => {
    const entityType = String(req.query.entityType || '').trim().toUpperCase() as DocumentEntityType;
    const entityId = String(req.query.entityId || '').trim();
    if (!DOCUMENT_ENTITY_TYPES.includes(entityType) || !entityId || entityId.length > 191) return null;
    return { entityType, entityId };
};

router.get('/', requireAnyPermission(READ_PERMISSIONS), async (req: Request, res: Response) => {
    try {
        const target = parseTarget(req);
        if (!target) return res.status(400).json({ error: 'Beleg fehlt oder ist unbekannt.' });
        const items = await loadDocumentHistory(prisma as any, { tenantId: req.user!.tenantId, ...target });
        res.status(200).json({ items });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

router.get('/summary', requireAnyPermission(READ_PERMISSIONS), async (req: Request, res: Response) => {
    try {
        const target = parseTarget(req);
        if (!target) return res.status(400).json({ error: 'Beleg fehlt oder ist unbekannt.' });
        const summary = await loadDocumentHistorySummary(prisma as any, { tenantId: req.user!.tenantId, ...target });
        res.status(200).json(summary);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

export default router;
