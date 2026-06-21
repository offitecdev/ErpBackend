import { Request, Response } from "express";
import prisma from "../../infrastructure/database/prisma.client";
import { nanoid } from "nanoid";

type ChecklistItemInput = {
    id?: string;
    category?: string;
    label?: string;
    measurement?: boolean;
};

/**
 * Normalises the items payload coming from the admin checklist builder into the
 * stored JSON shape. Every item keeps a stable id, a category, a label and a
 * flag deciding whether a measurement value (number/text) can be captured.
 */
function normalizeItems(raw: any): Array<{ id: string; category: string; label: string; measurement: boolean }> {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((item: ChecklistItemInput) => ({
            id: (item?.id && String(item.id)) || nanoid(8),
            category: String(item?.category || "").trim(),
            label: String(item?.label || "").trim(),
            measurement: Boolean(item?.measurement),
        }))
        .filter((item) => item.label.length > 0);
}

export class ChecklistController {
    async list(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const templates = await prisma.checklistTemplate.findMany({
                where: { tenantId },
                orderBy: { createdAt: "desc" },
            });
            res.status(200).json(templates);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getOne(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const template = await prisma.checklistTemplate.findFirst({
                where: { id: String(req.params.id), tenantId },
            });
            if (!template) return res.status(404).json({ error: "Kontrol listesi bulunamadı." });
            res.status(200).json(template);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async create(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const body = req.body || {};
            const name = String(body.name || "").trim();
            if (!name) return res.status(400).json({ error: "Liste adı zorunludur." });

            const template = await prisma.checklistTemplate.create({
                data: {
                    id: nanoid(8),
                    tenantId,
                    name,
                    description: body.description ? String(body.description) : null,
                    items: normalizeItems(body.items),
                    isActive: body.isActive !== false,
                },
            });
            res.status(201).json(template);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async update(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const body = req.body || {};
            const existing = await prisma.checklistTemplate.findFirst({
                where: { id: String(req.params.id), tenantId },
            });
            if (!existing) return res.status(404).json({ error: "Kontrol listesi bulunamadı." });

            const template = await prisma.checklistTemplate.update({
                where: { id: existing.id },
                data: {
                    name: body.name !== undefined ? String(body.name).trim() : existing.name,
                    description:
                        body.description !== undefined
                            ? body.description
                                ? String(body.description)
                                : null
                            : existing.description,
                    items: body.items !== undefined ? normalizeItems(body.items) : (existing.items as any),
                    isActive: body.isActive !== undefined ? Boolean(body.isActive) : existing.isActive,
                },
            });
            res.status(200).json(template);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async remove(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await prisma.checklistTemplate.findFirst({
                where: { id: String(req.params.id), tenantId },
            });
            if (!existing) return res.status(404).json({ error: "Kontrol listesi bulunamadı." });
            await prisma.checklistTemplate.delete({ where: { id: existing.id } });
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
