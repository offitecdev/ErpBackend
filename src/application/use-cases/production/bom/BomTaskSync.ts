import type { Bom, BomArea } from '../../../../domain/entities/ProductionBom';
import type { ProductionSubtask, ProductionTaskStatus } from '../../../../domain/entities/ProductionTask';
import type { IBomRevisionApprovals } from '../../../../domain/repositories/IBomRevisionApprovals';
import type { IBomRepository, IBomRevisionRepository } from '../../../../domain/repositories/IProductionBomRepository';
import type { IProductionDeviceTaskRepository } from '../../../../domain/repositories/IProductionTaskRepository';
import { BOM_STAGE, BOM_SUBTASK_ID } from '../../../../domain/services/productionTasks';
import type { BomActor } from './BomTemplatesUseCase';

/**
 * ── DIE BOM FÜHRT DIE UNTERAUFGABE «BOM CREATION» (02.10.2026) ──────────────
 *
 * «When the BOM is completed the BOM task should be done. If there is
 *  functionality to send the BOM to approval the status should reflect that
 *  like the other stages' approval status, or if there is a revision request
 *  for the BOM the status should reflect it.»
 *
 * Nach jeder Änderung an den BOMs eines Geräts in einem Bereich (Zeilen,
 * Alt-BOM, Freigabe, Abschluss, Revision) bekommt die Unteraufgabe
 * «BOM Creation» der Stufe «bom» dieses Bereichs ihren Stand aus der BOM:
 *
 *   Haupt-BOM abgeschlossen (oder verbraucht), keine Revision offen   DONE
 *   eine Revision zurückgewiesen («revision requested»)               REVISION
 *   eine Revision zur Freigabe eingereicht                            PENDING
 *   Zeilen, eine Alt-BOM, freigegeben oder eine Revision in Arbeit    IN_PROGRESS
 *   sonst                                                             TODO
 *
 * Die Aufgabe folgt ihren Unteraufgaben (Repository). Ein Gerät ohne Plan oder
 * ein Bereich ohne diese Unteraufgabe bleibt still — die BOM geht trotzdem.
 */
export class BomTaskSync {
    constructor(
        private tasks: IProductionDeviceTaskRepository,
        private boms: IBomRepository,
        private revisions: IBomRevisionRepository,
        private approvals: IBomRevisionApprovals | null,
    ) {}

    /** Für die BOM, an der gerade gehandelt wurde. Fehler hier halten die BOM nie auf. */
    async afterChange(tenantId: string, actor: Pick<BomActor, 'id' | 'name'>, bom: Pick<Bom, 'productionItemId' | 'area'>): Promise<void> {
        try {
            await this.sync(tenantId, actor, bom.productionItemId, bom.area);
        } catch (error) {
            console.warn('[production-bom] task sync failed', bom.productionItemId, bom.area, (error as Error)?.message);
        }
    }

    async sync(tenantId: string, actor: Pick<BomActor, 'id' | 'name'>, itemId: string, area: BomArea): Promise<void> {
        const plan = await this.tasks.getPlan(tenantId, itemId);
        const task = plan?.tasks.find((entry) =>
            entry.area === area && entry.stage === BOM_STAGE && entry.subtasks.some((subtask) => subtask.id === BOM_SUBTASK_ID));
        if (!task) return;

        const boms = (await this.boms.listForDevice(tenantId, itemId)).filter((bom) => bom.area === area);
        const drafts = boms.length ? await this.revisions.listForBoms(tenantId, boms.map((bom) => bom.id), { draftOnly: true, omitLines: true }) : [];
        const latest = this.approvals && drafts.length
            ? await this.approvals.latest(tenantId, drafts.map((draft) => draft.id))
            : new Map();
        const decisions = drafts.map((draft) => latest.get(draft.id) ?? null);
        const rejected = decisions.find((entry) => entry?.action === 'REJECTED') ?? null;
        const main = boms.find((bom) => bom.kind === 'MAIN') ?? null;

        let status: ProductionTaskStatus;
        if (main && (main.status === 'COMPLETED' || main.consumedAt) && !drafts.length) status = 'DONE';
        else if (rejected) status = 'REVISION';
        else if (decisions.some((entry) => entry?.action === 'SUBMITTED')) status = 'PENDING';
        else if (drafts.length || boms.some((bom) => bom.kind === 'SUB' || bom.status !== 'DRAFT' || bom.lines.length > 0)) status = 'IN_PROGRESS';
        else status = 'TODO';

        const at = new Date().toISOString();
        const change = (subtask: ProductionSubtask): ProductionSubtask => {
            if (status === 'DONE') {
                return subtask.status === 'DONE' && subtask.completedAt
                    ? subtask
                    : {
                        ...subtask,
                        status,
                        completedById: actor.id,
                        completedByName: actor.name,
                        completedAt: at,
                        completionNote: null,
                    };
            }
            const reopened = subtask.completedAt
                ? { completedById: null, completedByName: null, completedAt: null, completionNote: null }
                : {};
            if (status === 'REVISION' && rejected) {
                const rejectedAt = rejected.at.toISOString();
                // Dieselbe Rückgabe nur einmal in den Verlauf.
                const known = subtask.revisionHistory.some((entry) => entry.at === rejectedAt);
                return {
                    ...subtask,
                    ...reopened,
                    status,
                    revisionById: rejected.actorId,
                    revisionByName: rejected.actorName,
                    revisionAt: rejectedAt,
                    revisionNote: rejected.note,
                    revisionHistory: known
                        ? subtask.revisionHistory
                        : [...subtask.revisionHistory, { byId: rejected.actorId, byName: rejected.actorName, at: rejectedAt, note: rejected.note }].slice(-50),
                };
            }
            // «In Arbeit» von Hand (▶) bleibt, solange die BOM noch nichts trägt.
            const next = status === 'TODO' && subtask.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : status;
            return subtask.status === next && !subtask.completedAt ? subtask : { ...subtask, ...reopened, status: next };
        };
        await this.tasks.changeSubtask(tenantId, itemId, task.id, BOM_SUBTASK_ID, change, actor.id);
    }
}
