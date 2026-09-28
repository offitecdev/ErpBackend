/**
 * ── GÖREVLENDİRME DER PRODUKTION (26.09.2026, Vorgabe Samet) ────────────────
 *
 * «Üretim bölümlere ayrılıyor — Mekanik ve Elektrik … mekanikte cihaz seçimi
 *  başa, ama görevlendirme en başta … elektrikte devre tasarımı.»
 *
 * Ein Gerät durchläuft seine Stufen zweimal nebeneinander: einmal im Bereich
 * MECHANICAL (Mekanik), einmal im Bereich ELECTRICAL (Elektrik). Jede Aufgabe
 * gehört zu genau einem Bereich und genau einer Stufe; ihr Gewicht zählt
 * innerhalb des Bereichs, der Bereich trägt seinen Anteil zur
 * Gesamtfertigstellung bei (Chiller: 60 / 40).
 *
 * EIGENE BEREICHE UND STUFEN (28.09.2026): «when the user creates new template
 * they should create the sections manually, but keep the existing templates …
 * also stages should be created dynamically.» Eine Vorlage bringt ihre Bereiche
 * mit — Name, Anteil und die Stufen in der Reihenfolge des Weges. Mekanik und
 * Elektrik bleiben als FESTE Bereiche der Vorlagen von vorher: nur sie kennen
 * die BOM-Stufe und tragen ihre Namen aus der Übersetzung.
 *
 * Die Zuweisungen selbst sind keine Stufe mit Aufgaben — sie stehen vor dem
 * Weg («görevlendirme en başta»), darum kommen hier nur die Arbeitsstufen vor.
 */

/** Die zwei festen Bereiche — die Vorlagen von vor dem 28.09.2026 und die BOM hängen an ihnen. */
export type ProductionBuiltInArea = 'MECHANICAL' | 'ELECTRICAL';

/** Die Kennung eines Bereichs: ein fester oder ein eigener der Vorlage («s-…»). */
export type ProductionTaskArea = string;

/**
 * Die festen Arbeitsstufen der zwei Wege (dieselben Kennungen wie die Oberfläche):
 * Mekanik equipment · drawing · approval · bom · production · test · final,
 * Elektrik circuit · approval · bom · panel · test · final.
 */
export type ProductionBuiltInStage =
    | 'equipment'
    | 'circuit'
    | 'drawing'
    | 'approval'
    | 'bom'
    | 'production'
    | 'panel'
    | 'test'
    | 'final';

/** Die Kennung einer Stufe: eine feste oder eine eigene des Bereichs («g-…»). */
export type ProductionTaskStage = string;

/** Eine Stufe eines Bereichs. */
export interface ProductionTaskSectionStage {
    key: ProductionTaskStage;
    /** Leer bei den festen Stufen — ihr Name kommt aus der Übersetzung. */
    name: string;
}

/** Ein Bereich («bölüm») einer Vorlage: Anteil an der Gesamtfertigstellung und seine Stufen. */
export interface ProductionTaskSection {
    key: ProductionTaskArea;
    /** Leer bei den festen Bereichen — ihr Name kommt aus der Übersetzung. */
    name: string;
    /** Anteil an der Gesamtfertigstellung, in Prozent. */
    share: number;
    /** In der Reihenfolge des Weges. */
    stages: ProductionTaskSectionStage[];
}

/** Anteil je Bereich — Kennung → Prozent (Spalte `areaShares`, aus den Bereichen abgeleitet). */
export type ProductionAreaShares = Record<string, number>;

/** Ein Kalendertag `YYYY-MM-DD` — Beginn oder Termin einer Aufgabe. */
export type ProductionTaskDay = string;

/**
 * Eine Unteraufgabe (28.09.2026): «each task can have multiple subtasks …
 * two checkboxes (required fields: Document, Approval)». Ihre Tage liegen
 * innerhalb der Tage ihrer Aufgabe.
 */
/**
 * Eine Datei an einer Unteraufgabe am Gerät (28.09.2026: «show its files»).
 * `ref` ist der Verweis in die Ablage — er bleibt am Server.
 */
export interface ProductionSubtaskFile {
    id: string;
    ref: string;
    name: string;
    type: string;
    size: number;
    uploadedById: string | null;
    uploadedByName: string | null;
    /** Zeitpunkt (ISO). */
    uploadedAt: string;
}

export interface ProductionSubtask {
    id: string;
    name: string;
    /** Der Tag des Anlegens — Beginn, solange keiner gesetzt ist. */
    createdAt: ProductionTaskDay | null;
    /**
     * Gewicht als Anteil an der AUFGABE, in Prozent (28.09.2026: «10 means 10%
     * of its parent»): alle zusammen höchstens 100 %, im Bereich zählt es
     * Gewicht der Aufgabe × Anteil. Wiegt die Aufgabe 0, gibt es keins
     * («if the weight of the task is 0 we shouldn't be able to add weight to
     * the subtasks»). null = ohne.
     */
    weight: number | null;
    startDate: ProductionTaskDay | null;
    dueDate: ProductionTaskDay | null;
    /** Zur Unteraufgabe gehört ein Dokument. */
    requiresDocument: boolean;
    /** Die Unteraufgabe braucht eine Freigabe. */
    requiresApproval: boolean;
    /**
     * Der Stand der Unteraufgabe am Gerät (28.09.2026: «assign the statuses to
     * the subtasks»). In der Vorlage immer TODO — der Anfang.
     */
    status: ProductionTaskStatus;
    /** Dateien am Gerät (in der Vorlage keine). */
    files: ProductionSubtaskFile[];
    /**
     * Wer die Unteraufgabe abgeschlossen hat («Complete the task», nur die
     * Verwaltung) — mit Zeitpunkt (ISO) und kurzer Notiz. Abgeschlossen ist
     * sie gesperrt: zurück öffnet nur die Verwaltung.
     */
    completedById: string | null;
    completedByName: string | null;
    completedAt: string | null;
    completionNote: string | null;
}

/** Eine Aufgabe, wie sie gespeichert wird — in der Vorlage wie am Gerät. */
export interface ProductionTaskDraft {
    area: ProductionTaskArea;
    stage: ProductionTaskStage;
    code: string;
    name: string;
    /** Gewicht innerhalb des Bereichs, in Prozent. */
    weight: number;
    assigneeIds: string[];
    /** Beginn und Termin (28.09.2026) — frei lassbar. */
    startDate: ProductionTaskDay | null;
    dueDate: ProductionTaskDay | null;
    /** Der Tag des Anlegens (am Gerät: des Ladens) — Beginn, solange keiner gesetzt ist. */
    createdAt: ProductionTaskDay | null;
    subtasks: ProductionSubtask[];
}

export interface ProductionTemplateTask extends ProductionTaskDraft {
    id: string;
    sortOrder: number;
}

export interface ProductionTaskTemplate {
    id: string;
    tenantId: string;
    name: string;
    sections: ProductionTaskSection[];
    exampleKey: string | null;
    createdById: string | null;
    updatedById: string | null;
    createdAt: Date;
    updatedAt: Date;
    tasks: ProductionTemplateTask[];
}

/** Aufgaben und Gewichtssumme je Bereich (Kennung → Zahlen). */
export type ProductionAreaTotals = Record<string, { taskCount: number; weightSum: number }>;

/** Eine Zeile der Vorlagenliste — ohne die Aufgaben selbst. */
export interface ProductionTaskTemplateSummary {
    id: string;
    name: string;
    sections: ProductionTaskSection[];
    taskCount: number;
    /** Aufgaben und Gewichtssumme je Bereich (für die Prüfung). */
    areas: ProductionAreaTotals;
    /** Auf so vielen Geräten liegt eine Kopie dieser Vorlage. */
    usedBy: number;
    exampleKey: string | null;
    updatedAt: Date;
}

/** Was beim Anlegen/Ersetzen einer Vorlage gespeichert wird. */
export interface ProductionTaskTemplateInput {
    name: string;
    sections: ProductionTaskSection[];
    tasks: ProductionTaskDraft[];
}

/** Der Stand einer Aufgabe am Gerät (28.09.2026): offen, in Arbeit, erledigt. */
/**
 * PENDING (28.09.2026: «pending approval»): eine Unteraufgabe mit «Approval»
 * ist fertig und wartet auf «Complete the task» der Verwaltung. Kurz, damit
 * es in die Spalte `status` (VARCHAR(12)) passt.
 */
export type ProductionTaskStatus = 'TODO' | 'IN_PROGRESS' | 'PENDING' | 'DONE';

/** Die Aufgaben eines Geräts: der Plan (welche Vorlage, welche Bereiche) und seine Aufgaben. */
export interface ProductionDeviceTask extends ProductionTaskDraft {
    id: string;
    planId: string;
    status: ProductionTaskStatus;
    sortOrder: number;
    updatedById: string | null;
    updatedAt: Date;
}

export interface ProductionDeviceTaskPlan {
    id: string;
    tenantId: string;
    productionProjectId: string;
    productionItemId: string;
    templateId: string | null;
    templateName: string;
    /** Die Bereiche und Stufen, wie sie beim Laden galten — der Weg des Geräts. */
    sections: ProductionTaskSection[];
    loadedById: string | null;
    createdAt: Date;
    updatedAt: Date;
    tasks: ProductionDeviceTask[];
}

/** Das Gerät, an dem die Aufgaben hängen — gelesen aus `uretim_*`. */
export interface ProductionTaskDevice {
    id: string;
    productionProjectId: string;
    name: string;
    positionNumber: string | null;
    projectNumber: string;
    projectName: string;
    isActive: boolean;
}

/** Eine Person, die in einer Aufgabe steht. */
export interface ProductionTaskPerson {
    id: string;
    name: string;
    /** false: ausgetreten, gesperrt oder nicht mehr in dieser Firma. */
    active: boolean;
}
