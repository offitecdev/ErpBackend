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
    /**
     * Gewicht der Stufe im Bereich, in Prozent (30.09.2026: «the weights of the task only
     * should fill the weight of its stage») — die Stufen eines Bereichs ergeben 100 %.
     */
    weight: number;
    /** Sieht der Kunde diese Stufe (02.10.2026)? Fehlt = nein. */
    customerVisible?: boolean;
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
    /**
     * Fassungen derselben Datei (28.09.2026: «each file … can have revised versions»): alle
     * Fassungen tragen dieselbe `groupId` — die Kennung der ersten Fassung. `version` zählt
     * 1, 2, 3 …; die höchste ist die aktuelle.
     */
    groupId: string;
    version: number;
    /** Was sich in dieser Fassung geändert hat (Pflicht ab Fassung 2, 28.09.2026); null bei der ersten. */
    revisionNote: string | null;
    name: string;
    type: string;
    size: number;
    uploadedById: string | null;
    uploadedByName: string | null;
    /** Zeitpunkt (ISO). */
    uploadedAt: string;
    /** Die Prüfung gegen die Standards der Dokumente durch die KI (01.10.2026) — null: nie geprüft. */
    analysis: ProductionFileAnalysis | null;
}

/**
 * Das PDF mit den Standards einer Unteraufgabe (01.10.2026). `ref` zeigt in die eigene Ablage
 * der Standards — mit der Firma im Pfad; gelesen wird nur aus der eigenen Firma.
 */
export interface ProductionStandardsFile {
    ref: string;
    name: string;
    size: number;
    /** Zeitpunkt (ISO). */
    uploadedAt: string;
}

export type ProductionFileAnalysisStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
/** Das Urteil über die ganze Datei. */
export type ProductionFileAnalysisVerdict = 'PASS' | 'FAIL' | 'UNCLEAR';
/** Das Urteil über einen Standard. */
export type ProductionFileAnalysisResult = 'MET' | 'NOT_MET' | 'UNCLEAR';

/**
 * ── KI-PRÜFUNG EINES PDFs (01.10.2026, Vorgabe Samet) ──────────────────────
 *
 * «These standards are for AI to control them against the PDF.» Beim
 * Schicken zur Freigabe prüft gpt-5.4-mini jedes PDF gegen die Standards der
 * Unteraufgabe; die Verwaltung sieht den Bericht beim Prüfen der Dateien, wer
 * an der Unteraufgabe steht, darunter. Nur ein Rat — freigegeben wird wie
 * bisher von Hand.
 */
export interface ProductionFileAnalysis {
    status: ProductionFileAnalysisStatus;
    /** Die Standards, gegen die geprüft wird — ändern sie sich, gilt die Prüfung nicht mehr. */
    standards: string;
    /** … und das PDF der Standards (sein `ref`), falls eines dabei war. */
    standardsFileRef: string | null;
    /** Zeitpunkte (ISO). `requestedAt` kennzeichnet den Auftrag: ein älterer schreibt nicht mehr. */
    requestedAt: string;
    finishedAt: string | null;
    verdict: ProductionFileAnalysisVerdict | null;
    summary: string | null;
    checks: Array<{ standard: string; result: ProductionFileAnalysisResult; reason: string }>;
    model: string | null;
    /** Warum sie scheiterte (z. B. GPT_NOT_CONFIGURED, GPT_QUOTA, ANALYSIS_INTERRUPTED). */
    errorCode: string | null;
    /**
     * Die kurze Notiz der Einsendung, die mitgelesen wurde (02.10.2026, «kısa not da kanıttır») —
     * ändert sie sich, gilt die Prüfung nicht mehr. Ältere Prüfungen: null.
     */
    note: string | null;
    /**
     * Fotos werden ZUSAMMEN geprüft (02.10.2026): die Kennungen der Fotos, die in derselben Anfrage
     * lagen — derselbe Bericht steht an jedem. Leer bei einem PDF (jedes für sich).
     */
    groupFileIds: string[];
    /**
     * Derselbe Bericht in jeder Sprache der Oberfläche (02.10.2026: «give the
     * analysis in all languages OCC supports but show it in the language the
     * user uses»): Zusammenfassung und je Prüfpunkt Anforderung und Begründung,
     * in der Reihenfolge von `checks`. Ältere Berichte haben keinen (null).
     */
    i18n: ProductionFileAnalysisI18n | null;
}

export const PRODUCTION_UI_LANGUAGES = ['tr', 'en', 'de'] as const;
export type ProductionUiLanguage = typeof PRODUCTION_UI_LANGUAGES[number];
export type ProductionFileAnalysisI18n = Partial<Record<ProductionUiLanguage, {
    summary: string | null;
    checks: Array<{ standard: string; reason: string }>;
}>>;

/** Ein Punkt der Freigabe-Checkliste einer Unteraufgabe (28.09.2026). */
export interface ProductionSubtaskChecklistItem {
    id: string;
    text: string;
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
    /**
     * Wer an der Unteraufgabe arbeitet (29.09.2026: «they should only assign
     * people to subtasks»). Die Personen der Aufgabe sind nur noch die Summe
     * ihrer Unteraufgaben — eine Aufgabe ohne Unteraufgaben hat keine.
     */
    assigneeIds: string[];
    /** Zur Unteraufgabe gehört ein Dokument. */
    requiresDocument: boolean;
    /**
     * «Fotoğraf yeterli» (02.10.2026, OCC-Standard): nur mit «Document» — dann zählt auch ein
     * Foto (JPEG, PNG, WebP) als Dokument, nicht nur ein PDF. Ohne: wie bisher nur PDF.
     */
    photoAllowed: boolean;
    /**
     * «Ücret girilsin» (02.10.2026, OCC-Standard S. 7 «Teklif/fiyat … kayıtlı olur»): beim Einsenden
     * ist ein Betrag (CHF) Pflicht — etwa der Nakliye-Preis. Ohne: wie bisher kein Betrag.
     */
    feeRequired: boolean;
    /**
     * «Kilit» (02.10.2026, OCC-Standard S. 7 «Sistem kilidi — sevkiyat yasağı»): fertig melden und
     * freigeben erst, wenn alle Schritte DAVOR erledigt sind — die früheren Stufen und Aufgaben des
     * eigenen Wegs und der ganze andere Weg. Siehe `openPriorSteps`.
     */
    priorStepsRequired: boolean;
    /** Die Unteraufgabe braucht eine Freigabe. */
    requiresApproval: boolean;
    /** Was die Verwaltung bei der Freigabe prüft (nur mit «Approval», sonst leer). */
    approvalChecklist: ProductionSubtaskChecklistItem[];
    /**
     * Die Standards der Dokumente (01.10.2026: «the admin will write standarts
     * that the documents that are added to that subtask should meet»): freier
     * Text mit Zeilen, nur mit «Document» — sonst null. Steht beim Prüfen der
     * Dateien unter der Checkliste.
     */
    documentStandards: string | null;
    /**
     * Die Standards als PDF (01.10.2026: «the admins should be able to upload the standards as
     * pdf … both upload pdf and write text, the AI should consider both») — nur mit «Document».
     */
    documentStandardsFile: ProductionStandardsFile | null;
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
    /**
     * Die kurze Notiz beim Einsenden («Görevi tamamla», 02.10.2026) — Messwerte, Nakliye-Preis …;
     * die KI liest sie mit den Dateien. Gehört dem Server wie der Stand.
     */
    submissionNote: string | null;
    /**
     * Der Betrag beim Einsenden (02.10.2026, nur mit «Ücret girilsin») in CHF — gehört dem Server
     * wie die Notiz; die KI liest ihn mit der Notiz.
     */
    fee: number | null;
    /**
     * Zurück zur Überarbeitung (28.09.2026, «Request revision» beim Prüfen der
     * Dateien): wer, wann (ISO) und was zu ändern ist. Der Abschluss leert es.
     */
    revisionById: string | null;
    revisionByName: string | null;
    revisionAt: string | null;
    revisionNote: string | null;
    /**
     * Jede Rückgabe zur Überarbeitung (28.09.2026) — älteste zuerst. Anders als die Felder
     * oben bleibt sie auch nach der Freigabe stehen: die Prüfansicht zeigt den Verlauf.
     */
    revisionHistory: ProductionSubtaskRevisionRequest[];
    /**
     * Die Arbeitszeit (02.10.2026: «when the employee clicks on the play button
     * then stop button store the work time; if they stop and start again add the
     * new time to the old time»): Sekunden aus allen abgeschlossenen Runden,
     * dazu der Beginn der laufenden (ISO) — null, solange niemand arbeitet.
     */
    workSeconds: number;
    workStartedAt: string | null;
    /** Sieht der Kunde diese Unteraufgabe (02.10.2026)? Fehlt = nein. */
    customerVisible?: boolean;
}

/** Eine Rückgabe zur Überarbeitung (28.09.2026): wer, wann (ISO), was zu ändern war. */
export interface ProductionSubtaskRevisionRequest {
    byId: string | null;
    byName: string | null;
    at: string;
    note: string | null;
}

/** Eine Aufgabe, wie sie gespeichert wird — in der Vorlage wie am Gerät. */
export interface ProductionTaskDraft {
    area: ProductionTaskArea;
    stage: ProductionTaskStage;
    code: string;
    name: string;
    /**
     * Gewicht innerhalb der STUFE, in Prozent (30.09.2026) — die Aufgaben einer Stufe ergeben
     * 100 %. Gespeichert wird zusätzlich der Anteil am Bereich (Spalte `weight`), den ältere
     * Stände des Servers lesen; siehe `resolveTaskWeights`.
     */
    weight: number;
    /**
     * Alle Personen ihrer Unteraufgaben (29.09.2026) — abgeleitet, nie selbst
     * gesetzt: siehe `taskAssigneesOf`. Ohne Unteraufgaben leer.
     */
    assigneeIds: string[];
    /** Beginn und Termin (28.09.2026) — frei lassbar. */
    startDate: ProductionTaskDay | null;
    dueDate: ProductionTaskDay | null;
    /** Der Tag des Anlegens (am Gerät: des Ladens) — Beginn, solange keiner gesetzt ist. */
    createdAt: ProductionTaskDay | null;
    subtasks: ProductionSubtask[];
    /** Sieht der Kunde diese Aufgabe (02.10.2026)? Fehlt = nein. */
    customerVisible?: boolean;
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
    /** Bereich, Stufe und Gewicht (in der Stufe) jeder Aufgabe — für die Prüfung der Summen. */
    weights: Array<{ area: string; stage: string; weight: number }>;
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
/** REVISION (28.09.2026): von der Verwaltung zur Überarbeitung zurückgegeben — nur an Unteraufgaben. */
export type ProductionTaskStatus = 'TODO' | 'IN_PROGRESS' | 'REVISION' | 'PENDING' | 'DONE';

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

/**
 * ── DER VERLAUF EINER STUFE (30.09.2026, Vorgabe Samet) ─────────────────────
 *
 * «Who did what — xxx started a subtask, xxx stopped it, xxx sent it to the
 *  approval, xx uploaded a file, xxx deleted xxx file, xxx requested a
 *  revision, xxx created a subtask, xxx assigned to xxx, xxx subtask updated
 *  by xxx, xxx subtask deleted by xxx … I should click and see the details.»
 */
export type ProductionTaskActivityKind =
    /* Stand einer Unteraufgabe — wer an ihr steht */
    | 'SUBTASK_STARTED'
    | 'SUBTASK_STOPPED'
    | 'SUBTASK_SUBMITTED'
    | 'SUBTASK_DONE'
    /* Freigabe — die Verwaltung */
    | 'SUBTASK_APPROVED'
    | 'REVISION_REQUESTED'
    | 'SUBTASK_UNLOCKED'
    | 'CHECKLIST_ITEM_ADDED'
    /* Dateien */
    | 'FILE_UPLOADED'
    | 'FILE_DELETED'
    /* Personen */
    | 'SUBTASK_ASSIGNED'
    /* Anpassung der Kopie am Gerät */
    | 'TASK_CREATED'
    | 'TASK_UPDATED'
    | 'TASK_DELETED'
    | 'TASK_MOVED'
    | 'TASK_STATUS'
    | 'SUBTASK_CREATED'
    | 'SUBTASK_UPDATED'
    | 'SUBTASK_DELETED'
    | 'STAGE_ADDED'
    /* Anfragen an die Verwaltung (30.09.2026) */
    | 'UNLOCK_REQUESTED'
    | 'REQUEST_SOLVED'
    /* Tagesnotiz statt Datei (02.10.2026) — zählt in der Dateihistorie wie ein Hochladen */
    | 'DAILY_NOTE'
    /* das ganze Gerät (Bereich und Stufe leer) */
    | 'PLAN_LOADED'
    | 'PLAN_REMOVED';

/** Eine Zeile des Verlaufs — angehängt, nie geändert. */
export interface ProductionTaskActivityDraft {
    tenantId: string;
    productionItemId: string;
    /** null: das ganze Gerät — steht im Verlauf jeder Stufe. */
    area: string | null;
    stage: string | null;
    taskId: string | null;
    taskCode: string | null;
    taskName: string | null;
    subtaskId: string | null;
    subtaskCode: string | null;
    subtaskName: string | null;
    kind: ProductionTaskActivityKind;
    actorId: string | null;
    actorName: string | null;
    /** Was ein Klick zeigt: Dateien, Notizen, Änderungen (je nach Art). */
    details: Record<string, unknown> | null;
}

export interface ProductionTaskActivity extends ProductionTaskActivityDraft {
    id: string;
    createdAt: Date;
}

/**
 * ── ANFRAGEN AN DIE VERWALTUNG (30.09.2026) ─────────────────────────────────
 * APPROVAL: zur Freigabe geschickt (entsteht dabei selbst) · UNLOCK: Bitte um das Aufheben der Sperre.
 */
export type ProductionTaskRequestKind = 'APPROVAL' | 'UNLOCK';
/** Wie eine Anfrage erledigt wurde: von Hand oder durch die passende Handlung der Verwaltung. */
export type ProductionTaskRequestResolution = 'MANUAL' | 'APPROVED' | 'REVISION' | 'UNLOCKED';

export interface ProductionTaskRequestDraft {
    tenantId: string;
    productionItemId: string;
    area: string;
    stage: string;
    taskId: string;
    taskCode: string;
    taskName: string;
    subtaskId: string;
    subtaskCode: string;
    subtaskName: string;
    kind: ProductionTaskRequestKind;
    note: string | null;
    requestedById: string | null;
    requestedByName: string | null;
}

export interface ProductionTaskRequest extends ProductionTaskRequestDraft {
    id: string;
    createdAt: Date;
    solvedAt: Date | null;
    solvedById: string | null;
    solvedByName: string | null;
    resolution: ProductionTaskRequestResolution | null;
}

/** Eine Vorlage der Dokument-Standards (02.10.2026): Text und/oder PDF unter einem Namen. */
export interface ProductionStandardsTemplate {
    id: string;
    name: string;
    text: string | null;
    file: ProductionStandardsFile | null;
    updatedAt: string;
}
