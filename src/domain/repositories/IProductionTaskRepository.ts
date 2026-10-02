import type {
    ProductionDeviceTask,
    ProductionDeviceTaskPlan,
    ProductionSubtask,
    ProductionTaskActivity,
    ProductionTaskActivityDraft,
    ProductionTaskRequest,
    ProductionTaskRequestDraft,
    ProductionTaskRequestKind,
    ProductionTaskRequestResolution,
    ProductionTaskDevice,
    ProductionTaskDraft,
    ProductionTaskPerson,
    ProductionTaskSection,
    ProductionTaskStatus,
    ProductionTaskTemplate,
    ProductionTaskTemplateInput,
    ProductionTaskTemplateSummary,
    ProductionStandardsFile,
    ProductionStandardsTemplate,
} from '../entities/ProductionTask';

/**
 * ── DIE DATENBANKSEITE DER GÖREVLENDİRME ────────────────────────────────────
 *
 *   · IProductionTaskTemplateRepository — die Vorlagen der Firma
 *   · IProductionDeviceTaskRepository   — der Plan eines Geräts und seine Aufgaben
 *   · IProductionTaskDirectory          — was die Görevlendirme von anderen
 *                                         Modulen nur liest: das Gerät, Personen
 *   · IProductionTaskNotifier           — die Glocke der zugewiesenen Personen
 *   · IProductionTaskActivityLog        — der Verlauf je Stufe (30.09.2026)
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
    /**
     * Die Aufgaben des Plans neu (28.09.2026: die Verwaltung passt die Kopie
     * am Gerät an — die Vorlage bleibt, wie sie ist). Mitgebrachte Kennungen
     * bleiben, samt Stand und Zeitpunkt des Anlegens; null, wenn das Gerät
     * keinen Plan hat. `sections` (30.09.2026): die Bereiche samt Gewichten
     * der Stufen — im selben Vorgang gespeichert.
     */
    replaceTasks(
        tenantId: string,
        itemId: string,
        tasks: Array<ProductionTaskDraft & { id: string | null }>,
        actorId: string,
        sections: readonly ProductionTaskSection[],
    ): Promise<ProductionDeviceTaskPlan | null>;
    /**
     * Die Bereiche und Stufen der Kopie am Gerät (28.09.2026: neue Stufe in den Zuweisungen).
     * Aufgaben, Stände und Dateien bleiben unberührt; null ohne Plan.
     */
    setSections(tenantId: string, itemId: string, sections: ProductionTaskSection[]): Promise<ProductionDeviceTaskPlan | null>;
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
    /**
     * Die Geräte, an denen diese Person in einer Aufgabe steht (30.09.2026, «Görevlerim» auf der
     * Startseite) — eine Vorauswahl über die Personen der Aufgaben; welche Aufgaben es genau
     * sind, entscheidet der Anwendungsfall an den Unteraufgaben.
     */
    itemIdsForAssignee(tenantId: string, employeeId: string): Promise<string[]>;
}

export interface IProductionTaskDirectory {
    /** Das Gerät (Position des Produktionsprojekts) in dieser Firma. */
    device(tenantId: string, itemId: string): Promise<ProductionTaskDevice | null>;
    /** Welche dieser Kennungen aktive Personen der gewählten Firma sind. */
    activePeople(tenantId: string, ids: string[]): Promise<Set<string>>;
    /** Namen der Personen (auch Ausgetretene, als nicht aktiv markiert). */
    people(tenantId: string, ids: string[]): Promise<ProductionTaskPerson[]>;
    personName(id: string): Promise<string | null>;
    /**
     * Die Geräte der Firma, auf denen Aufgaben liegen, mit ihren Projekten (30.09.2026) — die
     * Auswahl von Projekt und Gerät für Anfragen und Verlauf auf der Startseite der Verwaltung.
     */
    taskDevices(tenantId: string): Promise<Array<{
        projectId: string;
        projectNumber: string;
        projectName: string;
        deviceId: string;
        deviceName: string;
        positionNumber: string | null;
        /** Die Vorlage, aus der die Aufgaben stammen, und wie viele es sind (30.09.2026). */
        templateName: string;
        taskCount: number;
    }>>;
}

/** Wer wofür neu in einer Aufgabe steht — Kennung der Person → ihre Aufgaben. */
export type ProductionAssignmentNews = Map<string, Array<Pick<ProductionTaskDraft, 'area' | 'stage' | 'code' | 'name'>>>;

/**
 * Was die Verwaltung an den Unteraufgaben einer Person getan hat (30.09.2026: «when they are
 * removed, or if the subtask is updated by admin, or if its status changes by something that
 * admin does they should see a notification»).
 *   REMOVED   von der Unteraufgabe genommen      DELETED   Unteraufgabe/Aufgabe gelöscht
 *   UPDATED   Angaben geändert (Name, Tage, …)   APPROVED  freigegeben
 *   REVISION  zur Überarbeitung zurück (Notiz)   UNLOCKED  Sperre aufgehoben — wieder in Arbeit
 */
export type ProductionTaskNoticeKind = 'REMOVED' | 'DELETED' | 'UPDATED' | 'APPROVED' | 'REVISION' | 'UNLOCKED';

export interface ProductionTaskNotice {
    kind: ProductionTaskNoticeKind;
    recipients: string[];
    /** «M-01.2» bzw. «M-01». */
    code: string;
    name: string;
    area: string;
    stage: string;
    /** Die Notiz der Rückgabe (REVISION). */
    note?: string | null;
}

export interface IProductionTaskNotifier {
    assigned(input: {
        tenantId: string;
        device: ProductionTaskDevice;
        actorId: string;
        actorName: string | null;
        news: ProductionAssignmentNews;
    }): Promise<void>;
    /** Neue Pflichten haben begonnene Unteraufgaben wieder geöffnet — die Leute der Aufgabe prüfen und schliessen neu ab. */
    reopened(input: {
        tenantId: string;
        device: ProductionTaskDevice;
        actorId: string;
        actorName: string | null;
        subtasks: ReadonlyArray<{ code: string; name: string; area: string; stage: string; recipients: string[] }>;
    }): Promise<void>;
    /** Jemand bittet, die Sperre einer Unteraufgabe aufzuheben — die Verwaltung erfährt es (30.09.2026). */
    unlockRequested(input: {
        tenantId: string;
        device: ProductionTaskDevice;
        actorId: string;
        actorName: string | null;
        code: string;
        name: string;
        area: string;
        stage: string;
        note: string | null;
    }): Promise<void>;
    /** Was die Verwaltung an Unteraufgaben getan hat — je Person und Art EINE Nachricht (30.09.2026). */
    changed(input: {
        tenantId: string;
        device: ProductionTaskDevice;
        actorId: string;
        actorName: string | null;
        notices: readonly ProductionTaskNotice[];
    }): Promise<void>;
}

/** Was aus dem Verlauf einer Stufe gezeigt wird (30.09.2026: Seiten und Zeitraum). */
export interface ProductionTaskActivityQuery {
    /** Nur diese Arten — null: alle. */
    kinds: string[] | null;
    /** Nur was diese Person tat — null: alle. */
    actorId: string | null;
    /** Zeitraum: ab `from` (einschliesslich), vor `to` (ausschliesslich) — je null: offen. */
    from: Date | null;
    to: Date | null;
    offset: number;
    limit: number;
}

/** Der Verlauf je Stufe (30.09.2026): angehängt, nie geändert — neueste zuerst gelesen. */
export interface IProductionTaskActivityLog {
    record(entries: ProductionTaskActivityDraft[]): Promise<void>;
    /**
     * Eine Seite des Verlaufs EINER Stufe samt den Handlungen am ganzen Gerät,
     * neueste zuerst — und wie viele Zeilen der Filter insgesamt trifft.
     */
    list(
        tenantId: string,
        itemId: string,
        /** Die Stufe — null: das ganze Gerät (30.09.2026, Startseite der Verwaltung). */
        place: { area: string; stage: string } | null,
        query: ProductionTaskActivityQuery,
    ): Promise<{ rows: ProductionTaskActivity[]; total: number }>;
    /** Wer in dieser Stufe (bzw. am ganzen Gerät) je etwas tat — für den Filter «Person». */
    actors(tenantId: string, itemId: string, place: { area: string; stage: string } | null): Promise<Array<{ id: string; name: string }>>;
}

/** Anfragen an die Verwaltung (30.09.2026): Freigabe und Entsperren, je Unteraufgabe. */
export interface IProductionTaskRequestRepository {
    create(draft: ProductionTaskRequestDraft): Promise<ProductionTaskRequest>;
    /** Die offene Anfrage dieser Art an dieser Unteraufgabe — höchstens eine zählt. */
    findOpen(tenantId: string, itemId: string, subtaskId: string, kind: ProductionTaskRequestKind): Promise<ProductionTaskRequest | null>;
    /** Die Anfragen einer Stufe (null: des ganzen Geräts), neueste zuerst — offen, erledigt oder alle. */
    list(
        tenantId: string,
        itemId: string,
        place: { area: string; stage: string } | null,
        status: 'open' | 'solved' | 'all',
    ): Promise<ProductionTaskRequest[]>;
    /** Wie viele Anfragen einer Stufe (null: des ganzen Geräts) noch offen sind. */
    countOpen(tenantId: string, itemId: string, place: { area: string; stage: string } | null): Promise<number>;
    /** Offene Anfragen je Gerät der Firma — für die Auswahl auf der Startseite. */
    openByDevice(tenantId: string): Promise<Map<string, number>>;
    /** Eine Anfrage erledigen; null, wenn es sie nicht gibt oder sie schon erledigt ist. */
    solve(
        tenantId: string,
        itemId: string,
        id: string,
        by: { id: string; name: string | null },
        resolution: ProductionTaskRequestResolution,
    ): Promise<ProductionTaskRequest | null>;
    /** Alle offenen Anfragen dieser Arten an einer Unteraufgabe erledigen (die passende Handlung geschah). */
    solveOpenFor(
        tenantId: string,
        itemId: string,
        subtaskId: string,
        kinds: readonly ProductionTaskRequestKind[],
        by: { id: string; name: string | null },
        resolution: ProductionTaskRequestResolution,
    ): Promise<number>;
}

/** Die Vorlagen der Dokument-Standards (02.10.2026). */
export interface IProductionStandardsTemplateRepository {
    list(tenantId: string): Promise<ProductionStandardsTemplate[]>;
    create(tenantId: string, input: { name: string; text: string | null; file: ProductionStandardsFile | null }, userId: string): Promise<ProductionStandardsTemplate | 'NAME_TAKEN'>;
    update(tenantId: string, id: string, input: { name: string; text: string | null; file: ProductionStandardsFile | null }, userId: string): Promise<ProductionStandardsTemplate | null | 'NAME_TAKEN'>;
    remove(tenantId: string, id: string): Promise<boolean>;
}
