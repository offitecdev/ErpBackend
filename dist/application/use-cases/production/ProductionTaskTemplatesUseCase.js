"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionTaskTemplatesUseCase = exports.isUniqueViolation = void 0;
const productionTasks_1 = require("../../../domain/services/productionTasks");
const productionTaskReadModel_1 = require("./productionTaskReadModel");
/** Ein Schlüssel ist schon vergeben (Prisma P2002). */
const isUniqueViolation = (error) => error?.code === 'P2002';
exports.isUniqueViolation = isUniqueViolation;
/**
 * ── GÖREVLENDİRME ŞABLONLARI (26.09.2026, Vorgabe Samet) ────────────────────
 *
 * «Üretimde yeni sayfa oluyor: görevlendirme şablonları — bu şablonları
 *  ekleyebiliyoruz.»
 *
 * Lesen darf, wer die Produktion sieht; anlegen, ändern und löschen nur die
 * Administratorrolle (die Wege prüfen das). Beim ersten Öffnen bekommt die
 * Firma das Beispiel «Chiller» — genau einmal: auch gelöscht kommt es nicht
 * wieder (die gelöschte Zeile bleibt stehen, und ihr Beispielschlüssel ist je
 * Firma eindeutig).
 *
 * Personen einer Vorlage müssen aktive Leute der gewählten Firma sein;
 * andere Kennungen fallen beim Speichern still heraus.
 */
class ProductionTaskTemplatesUseCase {
    templates;
    directory;
    /** Firmen, deren Beispiel in diesem Prozess schon geprüft ist. */
    exampleChecked = new Set();
    exampleInFlight = new Map();
    constructor(templates, directory) {
        this.templates = templates;
        this.directory = directory;
    }
    async list(tenantId) {
        await this.ensureExample(tenantId);
        const rows = await this.templates.list(tenantId);
        return rows.map(productionTaskReadModel_1.summaryDto);
    }
    async get(tenantId, id) {
        const template = await this.templates.get(tenantId, id);
        if (!template)
            throw this.notFound();
        return this.dto(tenantId, template);
    }
    async create(tenantId, actor, body) {
        const input = await this.inputFrom(tenantId, body);
        if (await this.templates.nameTaken(tenantId, input.name))
            throw this.nameTaken(input.name);
        const created = await this.templates.create(tenantId, actor.id, input);
        return this.dto(tenantId, created);
    }
    async update(tenantId, actor, id, body) {
        const input = await this.inputFrom(tenantId, body);
        if (await this.templates.nameTaken(tenantId, input.name, id))
            throw this.nameTaken(input.name);
        const saved = await this.templates.replace(tenantId, id, actor.id, input);
        if (!saved)
            throw this.notFound();
        return this.dto(tenantId, saved);
    }
    async remove(tenantId, actor, id) {
        if (!(await this.templates.softDelete(tenantId, id, actor.id)))
            throw this.notFound();
        return { deleted: true };
    }
    /* ── intern ─────────────────────────────────────────────────────── */
    /**
     * Das Beispiel «Chiller», wenn die Firma noch NIE eine Vorlage hatte.
     * Gleichzeitige Aufrufe teilen sich einen Vorgang; läuft trotzdem ein
     * zweiter Prozess dazwischen, scheitert sein Anlegen am eindeutigen
     * Beispielschlüssel — das ist dann kein Fehler.
     */
    async ensureExample(tenantId) {
        if (this.exampleChecked.has(tenantId))
            return;
        const pending = this.exampleInFlight.get(tenantId);
        if (pending)
            return pending;
        const run = (async () => {
            if ((await this.templates.countEver(tenantId)) > 0)
                return;
            try {
                await this.templates.create(tenantId, null, productionTasks_1.CHILLER_EXAMPLE, productionTasks_1.CHILLER_EXAMPLE_KEY);
            }
            catch (error) {
                if (!(0, exports.isUniqueViolation)(error))
                    throw error;
            }
        })();
        this.exampleInFlight.set(tenantId, run);
        try {
            await run;
            this.exampleChecked.add(tenantId);
        }
        finally {
            this.exampleInFlight.delete(tenantId);
        }
    }
    async inputFrom(tenantId, body) {
        const input = (0, productionTasks_1.templateInputFrom)(body);
        return { ...input, tasks: (0, productionTasks_1.orderTasks)(await this.keepActivePeople(tenantId, input.tasks), input.sections) };
    }
    async keepActivePeople(tenantId, tasks) {
        const ids = (0, productionTaskReadModel_1.assigneesOf)(tasks);
        if (!ids.length)
            return tasks;
        const active = await this.directory.activePeople(tenantId, ids);
        return tasks.map((task) => (0, productionTasks_1.withActiveAssignees)(task, active));
    }
    async dto(tenantId, template) {
        const [people, updatedByName] = await Promise.all([
            this.directory.people(tenantId, (0, productionTaskReadModel_1.assigneesOf)(template.tasks)),
            template.updatedById ? this.directory.personName(template.updatedById) : Promise.resolve(null),
        ]);
        return (0, productionTaskReadModel_1.templateDto)(template, people, updatedByName);
    }
    notFound() {
        return (0, productionTasks_1.productionTaskError)('TEMPLATE_NOT_FOUND', 'Vorlage nicht gefunden.', { status: 404 });
    }
    nameTaken(name) {
        return (0, productionTasks_1.productionTaskError)('NAME_TAKEN', `Es gibt schon eine Vorlage «${name}».`, { status: 409, params: { name } });
    }
}
exports.ProductionTaskTemplatesUseCase = ProductionTaskTemplatesUseCase;
//# sourceMappingURL=ProductionTaskTemplatesUseCase.js.map