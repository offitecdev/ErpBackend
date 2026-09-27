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
 * Die Zuweisungen selbst sind keine Stufe mit Aufgaben — sie stehen vor dem
 * Weg («görevlendirme en başta»), darum kommen hier nur die Arbeitsstufen vor.
 */

export type ProductionTaskArea = 'MECHANICAL' | 'ELECTRICAL';

/**
 * Die Arbeitsstufen der zwei Wege (dieselben Kennungen wie die Oberfläche):
 * Mekanik equipment · drawing · approval · bom · production · test · final,
 * Elektrik circuit · approval · bom · panel · test · final.
 */
export type ProductionTaskStage =
    | 'equipment'
    | 'circuit'
    | 'drawing'
    | 'approval'
    | 'bom'
    | 'production'
    | 'panel'
    | 'test'
    | 'final';

/** Anteil je Bereich an der Gesamtfertigstellung, in Prozent. */
export type ProductionAreaShares = Record<ProductionTaskArea, number>;

/** Eine Aufgabe, wie sie gespeichert wird — in der Vorlage wie am Gerät. */
export interface ProductionTaskDraft {
    area: ProductionTaskArea;
    stage: ProductionTaskStage;
    code: string;
    name: string;
    /** Gewicht innerhalb des Bereichs, in Prozent. */
    weight: number;
    assigneeIds: string[];
}

export interface ProductionTemplateTask extends ProductionTaskDraft {
    id: string;
    sortOrder: number;
}

export interface ProductionTaskTemplate {
    id: string;
    tenantId: string;
    name: string;
    areaShares: ProductionAreaShares;
    exampleKey: string | null;
    createdById: string | null;
    updatedById: string | null;
    createdAt: Date;
    updatedAt: Date;
    tasks: ProductionTemplateTask[];
}

/** Eine Zeile der Vorlagenliste — ohne die Aufgaben selbst. */
export interface ProductionTaskTemplateSummary {
    id: string;
    name: string;
    areaShares: ProductionAreaShares;
    taskCount: number;
    /** Aufgaben und Gewichtssumme je Bereich (für die Prüfung). */
    areas: Record<ProductionTaskArea, { taskCount: number; weightSum: number }>;
    /** Auf so vielen Geräten liegt eine Kopie dieser Vorlage. */
    usedBy: number;
    exampleKey: string | null;
    updatedAt: Date;
}

/** Was beim Anlegen/Ersetzen einer Vorlage gespeichert wird. */
export interface ProductionTaskTemplateInput {
    name: string;
    areaShares: ProductionAreaShares;
    tasks: ProductionTaskDraft[];
}

/** Die Aufgaben eines Geräts: der Plan (welche Vorlage, welche Anteile) und seine Aufgaben. */
export interface ProductionDeviceTask extends ProductionTaskDraft {
    id: string;
    planId: string;
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
    areaShares: ProductionAreaShares;
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
