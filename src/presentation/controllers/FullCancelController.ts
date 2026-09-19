import { Request, Response } from 'express';

import prisma from '../../infrastructure/database/prisma.client';
import { buildAppointmentCancellation, queueAppointmentCancellation } from '../../infrastructure/services/calendarMailService';
import { executeFullCancel, planFullCancel, type FullCancelScope } from '../../shared/fullCancel';
import { requestIp } from '../../shared/documentGovernance';
import { userHasPermission } from '../middlewares/RbacMiddleware';

/**
 * ── «GESAMTEN VORGANG STORNIEREN» — HTTP (17.09.2026, Schritt 6 / F1) ───────
 *
 *   GET  /sales-orders/:id/full-cancel   Vorschau für einen Auftrag
 *   POST /sales-orders/:id/full-cancel   ausführen
 *   GET  /projects/:id/full-cancel       Vorschau für ein Projekt
 *   POST /projects/:id/full-cancel       ausführen
 *
 * Die Wege hängen unter den bestehenden Modulpfaden, damit die Lesespeicher
 * von Aufträgen, Projekten, Offerten und Kalender mit ungültig werden.
 *
 * Rechte: das Storno-Recht des Umfangs (Route) und — sobald Rechnungen zu
 * regeln sind — zusätzlich `invoices.cancel`.
 */

const scopeOf = (req: Request, kind: FullCancelScope['kind']): FullCancelScope =>
    kind === 'ORDER'
        ? { kind, salesOrderId: String(req.params.id) }
        : { kind, projectId: String(req.params.id) };

const errorBody = (error: any) => ({
    error: error?.message || 'Error',
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.params ? { params: error.params } : {}),
    ...(error?.blockers ? { blockers: error.blockers } : {}),
});

export const previewFullCancel = (kind: FullCancelScope['kind']) => async (req: Request, res: Response) => {
    try {
        const tenantId = req.user!.tenantId;
        const plan = await planFullCancel(prisma as any, tenantId, scopeOf(req, kind));
        if (plan.blockers.includes('NOT_FOUND')) return res.status(404).json({ error: 'Nicht gefunden.', code: 'NOT_FOUND' });
        const canInvoices = !plan.needsInvoiceRight || await userHasPermission(req.user!.id, 'invoices.cancel');
        res.json({ ...plan, canSettleInvoices: canInvoices });
    } catch (error: any) {
        res.status(error?.status || 400).json(errorBody(error));
    }
};

export const runFullCancel = (kind: FullCancelScope['kind']) => async (req: Request, res: Response) => {
    try {
        const tenantId = req.user!.tenantId;
        const scope = scopeOf(req, kind);
        const reason = String(req.body?.reason || '').trim().slice(0, 1000);
        if (reason.length < 3) {
            return res.status(400).json({ error: 'Bitte einen Grund angeben.', code: 'CREDIT_REASON_REQUIRED' });
        }
        const rawCredits = req.body?.credits && typeof req.body.credits === 'object' ? req.body.credits : {};
        const credits: Record<string, number> = {};
        for (const [id, value] of Object.entries(rawCredits)) credits[id] = Number(value);
        const expectedInvoiceIds = Array.isArray(req.body?.expectedInvoiceIds)
            ? req.body.expectedInvoiceIds.map((id: unknown) => String(id))
            : undefined;

        // Vorab lesen: Rechte und Termin-Absagen (solange die Termine stehen).
        const plan = await planFullCancel(prisma as any, tenantId, scope);
        if (plan.blockers.includes('NOT_FOUND')) return res.status(404).json({ error: 'Nicht gefunden.', code: 'NOT_FOUND' });
        if (plan.needsInvoiceRight && !await userHasPermission(req.user!.id, 'invoices.cancel')) {
            return res.status(403).json({ error: 'Ihrer Rolle fehlt das Recht, Rechnungen zu stornieren.', code: 'CANCEL_NOT_PERMITTED' });
        }
        const cancellations = await Promise.all(
            plan.upcomingAppointmentIds.map((id) => buildAppointmentCancellation(id).catch(() => null)),
        );

        const result = await (prisma as any).$transaction(
            (tx: any) => executeFullCancel(tx, {
                tenantId,
                scope,
                reason,
                credits,
                actor: { employeeId: req.user!.id, ip: requestIp(req) },
                ...(expectedInvoiceIds ? { expectedInvoiceIds } : {}),
            }),
            { timeout: 60000, maxWait: 15000 },
        );

        const cancelled = new Set(result.cancelledAppointmentIds);
        cancellations.forEach((cancellation, index) => {
            if (cancellation && cancelled.has(plan.upcomingAppointmentIds[index]!)) {
                queueAppointmentCancellation(cancellation, req.user!.id);
            }
        });

        res.json(result);
    } catch (error: any) {
        res.status(error?.status || 400).json(errorBody(error));
    }
};
