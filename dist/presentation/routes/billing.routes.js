"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const BillingController_1 = require("../controllers/BillingController");
const CreateInvoiceUseCase_1 = require("../../application/use-cases/billing/CreateInvoiceUseCase");
const CreateDirectInvoiceUseCase_1 = require("../../application/use-cases/billing/CreateDirectInvoiceUseCase");
const GetBillingSummaryUseCase_1 = require("../../application/use-cases/billing/GetBillingSummaryUseCase");
const ListInvoicesUseCase_1 = require("../../application/use-cases/billing/ListInvoicesUseCase");
const UpdateInvoiceStatusUseCase_1 = require("../../application/use-cases/billing/UpdateInvoiceStatusUseCase");
const DeleteInvoiceUseCase_1 = require("../../application/use-cases/billing/DeleteInvoiceUseCase");
const InvoiceRepository_1 = require("../../infrastructure/repositories/InvoiceRepository");
const router = (0, express_1.Router)();
const invoiceRepo = new InvoiceRepository_1.InvoiceRepository();
const controller = new BillingController_1.BillingController(new CreateInvoiceUseCase_1.CreateInvoiceUseCase(invoiceRepo), new GetBillingSummaryUseCase_1.GetBillingSummaryUseCase(invoiceRepo), new ListInvoicesUseCase_1.ListInvoicesUseCase(invoiceRepo), new UpdateInvoiceStatusUseCase_1.UpdateInvoiceStatusUseCase(invoiceRepo), new DeleteInvoiceUseCase_1.DeleteInvoiceUseCase(invoiceRepo), new CreateDirectInvoiceUseCase_1.CreateDirectInvoiceUseCase(invoiceRepo));
router.use(AuthMiddleware_1.requireAuth);
router.get('/summary', (0, RbacMiddleware_1.requirePermission)('billing.view'), (req, res) => controller.getSummary(req, res));
router.get('/invoices', (0, RbacMiddleware_1.requirePermission)('billing.view'), (req, res) => controller.list(req, res));
router.post('/invoices', (0, RbacMiddleware_1.requirePermission)('billing.create'), (req, res) => controller.create(req, res));
// Direktrechnung — die selbst ausgefüllte Vorlage (weder Auftrag noch Projekt).
router.post('/invoices/direct', (0, RbacMiddleware_1.requirePermission)('billing.create'), (req, res) => controller.createDirect(req, res));
router.patch('/invoices/:id/status', (0, RbacMiddleware_1.requirePermission)('billing.manage'), (req, res) => controller.updateStatus(req, res));
// Kalıcı silme — yalnızca CANCELLED faturalar (use case doğrular).
router.delete('/invoices/:id', (0, RbacMiddleware_1.requirePermission)('billing.manage'), (req, res) => controller.delete(req, res));
exports.default = router;
//# sourceMappingURL=billing.routes.js.map