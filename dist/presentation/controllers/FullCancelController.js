"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runFullCancel = exports.previewFullCancel = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const calendarMailService_1 = require("../../infrastructure/services/calendarMailService");
const fullCancel_1 = require("../../shared/fullCancel");
const documentGovernance_1 = require("../../shared/documentGovernance");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
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
const scopeOf = (req, kind) => kind === 'ORDER'
    ? { kind, salesOrderId: String(req.params.id) }
    : { kind, projectId: String(req.params.id) };
const errorBody = (error) => ({
    error: error?.message || 'Error',
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.params ? { params: error.params } : {}),
    ...(error?.blockers ? { blockers: error.blockers } : {}),
});
const previewFullCancel = (kind) => async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const plan = await (0, fullCancel_1.planFullCancel)(prisma_client_1.default, tenantId, scopeOf(req, kind));
        if (plan.blockers.includes('NOT_FOUND'))
            return res.status(404).json({ error: 'Nicht gefunden.', code: 'NOT_FOUND' });
        const canInvoices = !plan.needsInvoiceRight || await (0, RbacMiddleware_1.userHasPermission)(req.user.id, 'invoices.cancel');
        res.json({ ...plan, canSettleInvoices: canInvoices });
    }
    catch (error) {
        res.status(error?.status || 400).json(errorBody(error));
    }
};
exports.previewFullCancel = previewFullCancel;
const runFullCancel = (kind) => async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const scope = scopeOf(req, kind);
        const reason = String(req.body?.reason || '').trim().slice(0, 1000);
        if (reason.length < 3) {
            return res.status(400).json({ error: 'Bitte einen Grund angeben.', code: 'CREDIT_REASON_REQUIRED' });
        }
        const rawCredits = req.body?.credits && typeof req.body.credits === 'object' ? req.body.credits : {};
        const credits = {};
        for (const [id, value] of Object.entries(rawCredits))
            credits[id] = Number(value);
        const expectedInvoiceIds = Array.isArray(req.body?.expectedInvoiceIds)
            ? req.body.expectedInvoiceIds.map((id) => String(id))
            : undefined;
        // Vorab lesen: Rechte und Termin-Absagen (solange die Termine stehen).
        const plan = await (0, fullCancel_1.planFullCancel)(prisma_client_1.default, tenantId, scope);
        if (plan.blockers.includes('NOT_FOUND'))
            return res.status(404).json({ error: 'Nicht gefunden.', code: 'NOT_FOUND' });
        if (plan.needsInvoiceRight && !await (0, RbacMiddleware_1.userHasPermission)(req.user.id, 'invoices.cancel')) {
            return res.status(403).json({ error: 'Ihrer Rolle fehlt das Recht, Rechnungen zu stornieren.', code: 'CANCEL_NOT_PERMITTED' });
        }
        const cancellations = await Promise.all(plan.upcomingAppointmentIds.map((id) => (0, calendarMailService_1.buildAppointmentCancellation)(id).catch(() => null)));
        const result = await prisma_client_1.default.$transaction((tx) => (0, fullCancel_1.executeFullCancel)(tx, {
            tenantId,
            scope,
            reason,
            credits,
            actor: { employeeId: req.user.id, ip: (0, documentGovernance_1.requestIp)(req) },
            ...(expectedInvoiceIds ? { expectedInvoiceIds } : {}),
        }), { timeout: 60000, maxWait: 15000 });
        const cancelled = new Set(result.cancelledAppointmentIds);
        cancellations.forEach((cancellation, index) => {
            if (cancellation && cancelled.has(plan.upcomingAppointmentIds[index])) {
                (0, calendarMailService_1.queueAppointmentCancellation)(cancellation, req.user.id);
            }
        });
        res.json(result);
    }
    catch (error) {
        res.status(error?.status || 400).json(errorBody(error));
    }
};
exports.runFullCancel = runFullCancel;
//# sourceMappingURL=FullCancelController.js.map