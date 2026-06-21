"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChecklistController = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const nanoid_1 = require("nanoid");
/**
 * Normalises the items payload coming from the admin checklist builder into the
 * stored JSON shape. Every item keeps a stable id, a category, a label and a
 * flag deciding whether a measurement value (number/text) can be captured.
 */
function normalizeItems(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .map((item) => ({
        id: (item?.id && String(item.id)) || (0, nanoid_1.nanoid)(8),
        category: String(item?.category || "").trim(),
        label: String(item?.label || "").trim(),
        measurement: Boolean(item?.measurement),
    }))
        .filter((item) => item.label.length > 0);
}
class ChecklistController {
    async list(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const templates = await prisma_client_1.default.checklistTemplate.findMany({
                where: { tenantId },
                orderBy: { createdAt: "desc" },
            });
            res.status(200).json(templates);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getOne(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const template = await prisma_client_1.default.checklistTemplate.findFirst({
                where: { id: String(req.params.id), tenantId },
            });
            if (!template)
                return res.status(404).json({ error: "Kontrol listesi bulunamadı." });
            res.status(200).json(template);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async create(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const body = req.body || {};
            const name = String(body.name || "").trim();
            if (!name)
                return res.status(400).json({ error: "Liste adı zorunludur." });
            const template = await prisma_client_1.default.checklistTemplate.create({
                data: {
                    id: (0, nanoid_1.nanoid)(8),
                    tenantId,
                    name,
                    description: body.description ? String(body.description) : null,
                    items: normalizeItems(body.items),
                    isActive: body.isActive !== false,
                },
            });
            res.status(201).json(template);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async update(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const body = req.body || {};
            const existing = await prisma_client_1.default.checklistTemplate.findFirst({
                where: { id: String(req.params.id), tenantId },
            });
            if (!existing)
                return res.status(404).json({ error: "Kontrol listesi bulunamadı." });
            const template = await prisma_client_1.default.checklistTemplate.update({
                where: { id: existing.id },
                data: {
                    name: body.name !== undefined ? String(body.name).trim() : existing.name,
                    description: body.description !== undefined
                        ? body.description
                            ? String(body.description)
                            : null
                        : existing.description,
                    items: body.items !== undefined ? normalizeItems(body.items) : existing.items,
                    isActive: body.isActive !== undefined ? Boolean(body.isActive) : existing.isActive,
                },
            });
            res.status(200).json(template);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async remove(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const existing = await prisma_client_1.default.checklistTemplate.findFirst({
                where: { id: String(req.params.id), tenantId },
            });
            if (!existing)
                return res.status(404).json({ error: "Kontrol listesi bulunamadı." });
            await prisma_client_1.default.checklistTemplate.delete({ where: { id: existing.id } });
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.ChecklistController = ChecklistController;
//# sourceMappingURL=ChecklistController.js.map