import type {
    ProductionDeviceTask,
    ProductionDeviceTaskPlan,
    ProductionSubtask,
    ProductionTaskDevice,
    ProductionTaskDraft,
    ProductionTaskPerson,
    ProductionTaskSection,
    ProductionTaskStatus,
    ProductionTaskTemplate,
    ProductionTaskTemplateInput,
    ProductionTaskTemplateSummary,
} from '../entities/ProductionTask';

/**
 * ── DIE DATENBANKSEITE DER GÖREVLENDİRME ────────────────────────────────────
 *
 *   · IProductionTaskTemplateRepository — die Vorlagen der Firma
 *   · IProductionDeviceTaskRepository   — der Plan eines Geräts und seine Aufgaben
 *   · IProductionTaskDirectory          — was die Görevlendirme von anderen
 *                                         Modulen nur liest: das Gerät, Personen
 *   · IProductionTaskNotifier           — die Glocke der zugewiesenen Personen
 */

export interface IProductionTaskTemplateRepository {
    /** Wie viele Vorlagen die Firma je hatte — auch gelöschte (Beispiel nur einmal). */
    countEver(tenantId: string): Promise<number>;
    list(tenantId: string): Promise<ProductionTaskTemplateSummary[]>;
    get(tenantId: string, id: string): Promise<ProductionTaskTemplate | null>;
    /** Trägt schon eine andere (nicht gelöschte) Vorlage diesen Namen? */
    nameTaken(tenantId: string, name: string, excludeId?: string): Promise<boolean>;
    create(
        tenantId: string,
        actorId: string | null,
        input: ProductionTaskTemplateInput,
        exampleKey?: string,
    ): Promise<ProductionTaskTemplate>;
    /** Name, Bereiche und ALLE Aufgaben neu — in einem Vorgang. */
    replace(tenantId: string, id: string, actorId: string, input: ProductionTaskTemplateInput): Promise<ProductionTaskTemplate | null>;
    softDelete(tenantId: string, id: string, actorId: string): Promise<boolean>;
}

export interface ProductionDevicePlanWrite {
    device: ProductionTaskDevice;
    templateId: string;
    templateName: string;
    /** Die Bereiche und Stufen der Vorlage — der Weg des Geräts. */
    sections: ProductionTaskSection[];
    actorId: string;
    tasks: ProductionTaskDraft[];
}

export interface IProductionDeviceTaskRepository {
    getPlan(tenantId: string, itemId: string): Promise<ProductionDeviceTaskPlan | null>;
    /** Legt den Plan an; ein bestehender Plan des Geräts wird im selben Vorgang ersetzt. */
    replacePlan(tenantId: string, write: ProductionDevicePlanWrite): Promise<ProductionDeviceTaskPlan>;
    /** Neue Personen einer Aufgabe; gibt die Aufgabe und die Personen davor zurück. */
    setAssignees(
        tenantId: string,
        itemId: string,
        taskId: string,
        assigneeIds: string[],
        actorId: string,
    ): Promise<{ task: ProductionDeviceTask; previous: string[] } | null>;
    /**
     * Die Aufgaben des Plans neu (28.09.2026: die Verwaltung passt die Kopie
     * am Gerät an — die Vorlage bleibt, wie sie ist). Mitgebrachte Kennungen
     * bleiben, samt Stand und Zeitpunkt des Anlegens; null, wenn das Gerät
     * keinen Plan hat.
     */
    replaceTasks(
        tenantId: string,
        itemId: string,
        tasks: Array<ProductionTaskDraft & { id: string | null }>,
        actorId: string,
    ): Promise<ProductionDeviceTaskPlan | null>;
    /** Eine Aufgabe des Geräts (für die Prüfung, wer ihren Stand setzen darf). */
    getTask(tenantId: string, itemId: string, taskId: string): Promise<ProductionDeviceTask | null>;
    /** Der neue Stand einer Aufgabe; null, wenn es sie nicht gibt. */
    setStatus(
        tenantId: string,
        itemId: string,
        taskId: string,
        status: ProductionTaskStatus,
        actorId: string,
    ): Promise<ProductionDeviceTask | null>;
    /**
     * EINE Unteraufgabe ändern (Stand, Dateien, Abschluss) — in einem
     * Vorgang mit gesperrter Zeile, damit zwei gleichzeitige Änderungen
     * einander nicht überschreiben. `change` darf werfen (dann bleibt alles).
     * Der Stand der Aufgabe folgt aus denen ihrer Unteraufgaben. null, wenn
     * es die Aufgabe nicht gibt; 'no-subtask', wenn es die Unteraufgabe nicht gibt.
     */
    changeSubtask(
        tenantId: string,
        itemId: string,
        taskId: string,
        subtaskId: string,
        change: (subtask: ProductionSubtask, task: ProductionDeviceTask) => ProductionSubtask,
        actorId: string,
    ): Promise<ProductionDeviceTask | null | 'no-subtask'>;
    deletePlan(tenantId: string, itemId: string): Promise<boolean>;
}

export interface IProductionTaskDirectory {
    /** Das Gerät (Position des Produktionsprojekts) in dieser Firma. */
    device(tenantId: string, itemId: string): Promise<ProductionTaskDevice | null>;
    /** Welche dieser Kennungen aktive Personen der gewählten Firma sind. */
    activePeople(tenantId: string, ids: string[]): Promise<Set<string>>;
    /** Namen der Personen (auch Ausgetretene, als nicht aktiv markiert). */
    people(tenantId: string, ids: string[]): Promise<ProductionTaskPerson[]>;
    personName(id: string): Promise<string | null>;
}

/** Wer wofür neu in einer Aufgabe steht — Kennung der Person → ihre Aufgaben. */
export type ProductionAssignmentNews = Map<string, Array<Pick<ProductionTaskDraft, 'area' | 'stage' | 'code' | 'name'>>>;

export interface IProductionTaskNotifier {
    assigned(input: {
        tenantId: string;
        device: ProductionTaskDevice;
        actorId: string;
        actorName: string | null;
        news: ProductionAssignmentNews;
    }): Promise<void>;
}
