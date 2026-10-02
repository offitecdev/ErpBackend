import type {
    ProductionAreaShares,
    ProductionAreaTotals,
    ProductionBuiltInArea,
    ProductionBuiltInStage,
    ProductionDeviceTask,
    ProductionFileAnalysis,
    ProductionStandardsFile,
    ProductionSubtask,
    ProductionSubtaskChecklistItem,
    ProductionSubtaskFile,
    ProductionTaskDraft,
    ProductionTaskSection,
    ProductionTaskSectionStage,
    ProductionTaskStatus,
    ProductionTaskTemplateInput,
} from '../entities/ProductionTask';

/**
 * ── GÖREVLENDİRME · DIE REGELN (26.09.2026, Vorgabe Samet) ─────────────────
 *
 * Reine Regeln ohne Datenbank: welche Bereiche und Stufen es gibt, wie eine
 * Vorlage aussehen muss, wann sie vollständig ist, und das Beispiel «Chiller»
 * mit den Aufgaben aus Samets Liste.
 *
 * VOLLSTÄNDIG heisst: die Anteile der Bereiche ergeben 100 %, und in jedem
 * Bereich mit Anteil ergeben die Gewichte seiner Aufgaben 100 %. Gespeichert
 * werden darf auch eine unvollständige Vorlage (man baut sie Stück für
 * Stück); auf ein Gerät laden lässt sich nur eine vollständige.
 *
 * EIGENE BEREICHE UND STUFEN (28.09.2026): eine neue Vorlage beginnt leer —
 * die Bereiche (Name, Anteil) und ihre Stufen legt man selbst an. Die
 * Vorlagen von vorher tragen keine Liste und behalten die FESTEN Bereiche
 * Mekanik / Elektrik mit ihren festen Stufen (`builtInSections`). Die Kürzel
 * der Aufgaben vergibt die Oberfläche (M-01, H-03 …); fehlt eins, vergibt es
 * der Server. Jede Aufgabe kann Unteraufgaben haben.
 */

export const BUILT_IN_AREAS: readonly ProductionBuiltInArea[] = ['MECHANICAL', 'ELECTRICAL'];

/**
 * Die ZWEI WEGE des Geräts (27.09.2026, Vorgabe Samet: «Üretim hedef yolu iki
 * yola ayrılmalıdır — makine, elektrik … ayrı takip edilir»):
 *
 *   Mekanik   Compressor seçimi & PID › Teknik çizim › Final çizim onayı ›
 *             BOM › Üretim/Montaj › Test › Final
 *   Elektrik  Teknik devre çizimi (EPLAN) › Final çizim onayı › BOM ›
 *             Pano imalatı › Test › Final
 *
 * «Satın alma» gehört zu keinem der beiden Wege mehr. Die Zuweisungen
 * (Görevlendirme) stehen vor jedem Weg und sind keine Stufe mit Aufgaben.
 * Seit dem 28.09.2026 sind das die Stufen der FESTEN Bereiche.
 */
export const BUILT_IN_STAGES: Readonly<Record<ProductionBuiltInArea, readonly ProductionBuiltInStage[]>> = {
    MECHANICAL: ['equipment', 'drawing', 'approval', 'bom', 'production', 'test', 'final'],
    ELECTRICAL: ['circuit', 'approval', 'bom', 'panel', 'test', 'final'],
};

const BUILT_IN_STAGE_KEYS: ReadonlySet<string> = new Set([...BUILT_IN_STAGES.MECHANICAL, ...BUILT_IN_STAGES.ELECTRICAL]);

export const isBuiltInArea = (value: unknown): value is ProductionBuiltInArea =>
    typeof value === 'string' && (BUILT_IN_AREAS as readonly string[]).includes(value);

export const isBuiltInStage = (value: unknown): value is ProductionBuiltInStage =>
    typeof value === 'string' && BUILT_IN_STAGE_KEYS.has(value);

/**
 * Wohin eine Stufe gehört, die es im festen Bereich (nicht mehr) gibt — für
 * Aufgaben aus der Zeit vor den zwei Wegen und für einen Browser mit altem
 * Stand: die Zeichnung der Mekanik wird in der Elektrik zum EPLAN-Stromlauf,
 * die Montage zum Schaltschrankbau, der Einkauf fällt auf die Stückliste.
 */
const STAGE_TWINS: Readonly<Record<string, Partial<Record<ProductionBuiltInArea, ProductionBuiltInStage>>>> = {
    equipment: { ELECTRICAL: 'circuit' },
    circuit: { MECHANICAL: 'equipment' },
    drawing: { ELECTRICAL: 'circuit' },
    production: { ELECTRICAL: 'panel' },
    panel: { MECHANICAL: 'production' },
    purchasing: { MECHANICAL: 'bom', ELECTRICAL: 'bom' },
};

/**
 * Die Stufe eines Bereichs zu einer gespeicherten/gesendeten Kennung — in den
 * festen Bereichen auch ihr Gegenstück im anderen Weg; unbekannt → null.
 */
export const stageOfSection = (section: ProductionTaskSection, value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    if (section.stages.some((stage) => stage.key === value)) return value;
    const twin = isBuiltInArea(section.key) ? STAGE_TWINS[value]?.[section.key] : undefined;
    return twin && section.stages.some((stage) => stage.key === twin) ? twin : null;
};

export const PRODUCTION_TASK_LIMITS = {
    templateName: 120,
    code: 16,
    taskName: 200,
    tasks: 200,
    assignees: 20,
    sections: 12,
    sectionName: 60,
    stages: 20,
    stageName: 60,
    subtasks: 30,
    subtaskName: 200,
    checklistItems: 30,
    checklistItemText: 200,
    documentStandards: 2000,
} as const;

/**
 * Kennungen eigener Bereiche, Stufen und Unteraufgaben vergibt die Oberfläche
 * («s-…», «g-…», «u-…»); sie passen in die Spalten `area` (16) und `stage` (24).
 */
const SECTION_KEY = /^[A-Za-z0-9_-]{1,16}$/;
const STAGE_KEY = /^[A-Za-z0-9_-]{1,24}$/;
const SUBTASK_ID = /^[A-Za-z0-9_-]{1,24}$/;
/** Die Stufe der Zuweisungen am Gerät — keine Arbeitsstufe, also keine Kennung einer eigenen. */
const RESERVED_STAGE_KEYS: ReadonlySet<string> = new Set(['assignments']);

/** Rechentoleranz der Prozentsummen (zwei Nachkommastellen). */
const SUM_TOLERANCE = 0.01;

/* ── Fehler mit Kennung ─────────────────────────────────────────────────── */

export type ProductionTaskErrorCode =
    | 'TEMPLATE_NOT_FOUND'
    | 'TEMPLATE_REQUIRED'
    | 'TEMPLATE_INCOMPLETE'
    | 'NAME_REQUIRED'
    | 'NAME_TAKEN'
    | 'SHARES_INVALID'
    | 'SECTIONS_TOO_MANY'
    | 'SECTION_INVALID'
    | 'SECTION_NAME_REQUIRED'
    | 'SECTION_NAME_TAKEN'
    | 'STAGES_TOO_MANY'
    | 'STAGE_NAME_REQUIRED'
    | 'STAGE_NAME_TAKEN'
    | 'TASKS_TOO_MANY'
    | 'TASK_INVALID'
    | 'SUBTASK_WEIGHTS_INVALID'
    | 'TASK_DATES_INVALID'
    | 'CODE_DUPLICATE'
    | 'DEVICE_NOT_FOUND'
    | 'PLAN_EXISTS'
    | 'PLAN_NOT_FOUND'
    | 'STAGE_REQUIRED'
    | 'STAGE_WEIGHT_INVALID'
    | 'UNLOCK_ALREADY_REQUESTED'
    | 'REQUEST_NOT_FOUND'
    | 'TASK_NOT_FOUND'
    | 'STATUS_INVALID'
    | 'STATUS_FORBIDDEN'
    | 'SUBTASK_NOT_FOUND'
    | 'APPROVAL_REQUIRED'
    | 'SUBTASK_LOCKED'
    | 'NOT_LOCKED'
    | 'SUBTASK_AWAITING'
    | 'NOT_IN_PROGRESS'
    | 'STATUS_FLOW'
    | 'CHECKLIST_INCOMPLETE'
    | 'CHECKLIST_ITEM_REQUIRED'
    | 'SECTION_FULL'
    | 'REVISION_NOTE_REQUIRED'
    | 'CHECKLIST_TOO_MANY'
    // KI-Prüfung der PDFs gegen die Standards (01.10.2026).
    | 'NO_STANDARDS'
    | 'ANALYSIS_RUNNING'
    | 'STANDARDS_FILE_NOT_FOUND'
    | 'NOT_PENDING'
    | 'NOT_APPROVABLE'
    | 'ALREADY_COMPLETED'
    | 'DOCUMENT_REQUIRED'
    | 'FILE_REQUIRED'
    | 'FILE_TYPE'
    | 'FILE_TOO_LARGE'
    | 'FILES_TOO_MANY'
    | 'FILE_NOT_FOUND'
    | 'FILE_FORBIDDEN'
    // OCC-Standard S. 7 (02.10.2026): Betrag beim Einsenden, Sperre bis die Schritte davor erledigt sind.
    | 'FEE_REQUIRED'
    | 'FEE_INVALID'
    | 'PRIOR_STEPS_OPEN';

export type ProductionTaskError = Error & {
    code: ProductionTaskErrorCode;
    status: number;
    params?: Record<string, string | number> | undefined;
    details?: unknown;
};

export const productionTaskError = (
    code: ProductionTaskErrorCode,
    message: string,
    options: { status?: number; params?: Record<string, string | number>; details?: unknown } = {},
): ProductionTaskError =>
    Object.assign(new Error(message), {
        code,
        status: options.status ?? 400,
        params: options.params,
        details: options.details,
    });

export const isProductionTaskError = (error: unknown): error is ProductionTaskError =>
    Boolean(error)
    && typeof (error as ProductionTaskError).code === 'string'
    && typeof (error as ProductionTaskError).status === 'number';

export const productionTaskErrorBody = (error: ProductionTaskError) => ({
    error: error.message || 'Error',
    code: error.code,
    ...(error.params ? { params: error.params } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
});

/* ── Kleine Helfer ──────────────────────────────────────────────────────── */

/** Prozentwert auf zwei Nachkommastellen. */
export const roundPercent = (value: number): number => Math.round(value * 100) / 100;

const text = (value: unknown, max: number): string =>
    (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Wie `text`, aber die Zeilen bleiben (höchstens eine Leerzeile am Stück). */
const multilineText = (value: unknown, max: number): string =>
    (typeof value === 'string' ? value : '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, max);

const objectOf = (value: unknown): Record<string, unknown> =>
    (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;

const percentFrom = (value: unknown): number | null => {
    const number = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
    if (typeof value === 'boolean' || value === null || value === undefined || value === '') return null;
    if (!Number.isFinite(number) || number < 0 || number > 100) return null;
    return roundPercent(number);
};

/**
 * Zwei Namen sind derselbe, wenn sie sich nur in Gross/klein unterscheiden —
 * auch über das türkische I hinweg («MEKANIK» wie «Mekanik» wie «MEKANİK»).
 */
const nameKey = (value: string): string => value.toLocaleLowerCase('tr-TR').replace(/ı/g, 'i');
const sameName = (left: string, right: string): boolean => nameKey(left) === nameKey(right);

/** Eine neue Kennung — nur für Unteraufgaben, die ohne eine ankommen. */
const randomKey = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;

/**
 * Ein Kalendertag `YYYY-MM-DD` (28.09.2026: Beginn und Termin). Leer → null,
 * Unlesbares oder ein Tag, den es nicht gibt (31.02.) → undefined.
 */
export const dayFrom = (value: unknown): string | null | undefined => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') return undefined;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return undefined;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    return real ? match[0] : undefined;
};

/** Personenkennungen: Zeichenketten, ohne Doppelte, höchstens 20. */
export const assigneeIdsFrom = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const id = entry.trim();
        if (!id || id.length > 64 || ids.includes(id)) continue;
        ids.push(id);
        if (ids.length >= PRODUCTION_TASK_LIMITS.assignees) break;
    }
    return ids;
};

/**
 * Die Personen einer Aufgabe (29.09.2026: «only assign people to subtasks —
 * but on the people cell of the main task show all people that are assigned
 * to a subtask under that main task»): die Summe ihrer Unteraufgaben, in der
 * Reihenfolge, in der sie zuerst vorkommen. Früher an der Aufgabe selbst
 * gesetzte Personen fallen damit weg (Vorgabe: «drop them»).
 */
export const taskAssigneesOf = (subtasks: ReadonlyArray<Pick<ProductionSubtask, 'assigneeIds'>>): string[] =>
    [...new Set(subtasks.flatMap((subtask) => subtask.assigneeIds))];

/** Nur wer noch aktiv ist, bleibt an den Unteraufgaben; die Aufgabe rechnet ihre Personen neu. */
export const withActiveAssignees = <T extends Pick<ProductionTaskDraft, 'assigneeIds' | 'subtasks'>>(task: T, active: ReadonlySet<string>): T => {
    const subtasks = task.subtasks.map((subtask) => ({ ...subtask, assigneeIds: subtask.assigneeIds.filter((id) => active.has(id)) }));
    return { ...task, subtasks, assigneeIds: taskAssigneesOf(subtasks) };
};

/** Arbeitet die Person an dieser Unteraufgabe? Nur wer an ihr steht — auch die Verwaltung nicht von selbst (29.09.2026). */
export const worksOnSubtask = (subtask: Pick<ProductionSubtask, 'assigneeIds'>, personId: string): boolean =>
    subtask.assigneeIds.includes(personId);

/** Vergleich von Kürzeln: ohne Gross/klein, ohne Leerraum. */
const codeKey = (code: string): string => code.replace(/\s+/g, '').toLocaleUpperCase('tr-TR');

export const sameTaskCode = (left: string, right: string): boolean => codeKey(left) === codeKey(right);

/* ── Bereiche und Stufen ────────────────────────────────────────────────── */

/** Die festen Bereiche einer Vorlage von vorher: Mekanik und Elektrik mit ihren Stufen. */
export const builtInSections = (areaShares: unknown): ProductionTaskSection[] => {
    const shares = objectOf(areaShares);
    return BUILT_IN_AREAS.map((area) => ({
        key: area,
        name: '',
        share: percentFrom(shares[area]) ?? 0,
        // Das Gewicht der Stufen kennt eine Vorlage von vorher nicht — `resolveTaskWeights` leitet es ab.
        stages: BUILT_IN_STAGES[area].map((key) => ({ key, name: '', weight: 0 })),
    }));
};

/**
 * Die Bereiche aus der Datenbank. Steht keine Liste da (NULL — eine Vorlage
 * oder ein Plan von vor dem 28.09.2026), gelten die festen Bereiche mit den
 * Anteilen aus `areaShares`. Was sich nicht lesen lässt, fällt heraus; eine
 * leere Liste ist eine neue Vorlage ohne Bereiche.
 */
export const sectionsFrom = (stored: unknown, areaShares: unknown): ProductionTaskSection[] => {
    if (!Array.isArray(stored)) return builtInSections(areaShares);
    const sections: ProductionTaskSection[] = [];
    for (const raw of stored) {
        const row = objectOf(raw);
        const key = typeof row.key === 'string' ? row.key : '';
        if (!SECTION_KEY.test(key) || sections.some((section) => section.key === key)) continue;
        const stages: ProductionTaskSectionStage[] = [];
        for (const rawStage of Array.isArray(row.stages) ? row.stages : []) {
            const stage = objectOf(rawStage);
            const stageKey = typeof stage.key === 'string' ? stage.key : '';
            if (!STAGE_KEY.test(stageKey) || RESERVED_STAGE_KEYS.has(stageKey) || stages.some((entry) => entry.key === stageKey)) continue;
            stages.push({ key: stageKey, name: text(stage.name, PRODUCTION_TASK_LIMITS.stageName), weight: percentFrom(stage.weight) ?? 0 });
        }
        sections.push({
            key,
            name: isBuiltInArea(key) ? '' : text(row.name, PRODUCTION_TASK_LIMITS.sectionName),
            share: percentFrom(row.share) ?? 0,
            stages,
        });
    }
    return sections;
};

/** Anteil je Bereich — für die Spalte `areaShares` und ältere Browserstände. */
export const areaSharesOf = (sections: readonly ProductionTaskSection[]): ProductionAreaShares =>
    Object.fromEntries(sections.map((section) => [section.key, section.share]));

/* ── Gewichte: Stufe im Bereich, Aufgabe in der Stufe (30.09.2026) ───────────
 *
 * «The weights of the task only should fill the weight of its stage, not the
 *  other stages.» Jede Stufe trägt ein Gewicht im Bereich (die Stufen eines
 * Bereichs ergeben 100 %), jede Aufgabe ein Gewicht in ihrer Stufe (die
 * Aufgaben einer Stufe ergeben 100 %). Beitrag zur Gesamtfertigstellung =
 * Anteil des Bereichs × Gewicht der Stufe × Gewicht der Aufgabe.
 *
 * GESPEICHERT wird so, dass ein älterer Stand des Servers (dieselbe Datenbank)
 * weiterläuft: die Spalte `weight` hält wie bisher den Anteil der Aufgabe am
 * BEREICH; das Gewicht in der Stufe steht daneben (`stageWeight`), das der
 * Stufe in den Bereichen (`sections[].stages[].weight`). Fehlt eines davon —
 * Daten von vorher oder von einem älteren Stand —, wird es aus den Anteilen am
 * Bereich abgeleitet: Stufe = Summe ihrer Aufgaben, Aufgabe = Anteil / Stufe.
 */

/** Tragen alle Stufen der gespeicherten Bereiche ein Gewicht? (NULL = Vorlage von vorher: nein.) */
export const storedStageWeightsComplete = (stored: unknown): boolean =>
    Array.isArray(stored) && stored.every((raw) => {
        const stages = objectOf(raw).stages;
        return Array.isArray(stages) && stages.every((stage) => typeof objectOf(stage).weight === 'number');
    });

/** Der Anteil einer Aufgabe am Bereich — für die Spalte `weight` (ältere Stände lesen sie). */
export const sectionShareOf = (stageWeight: number, taskWeight: number): number =>
    Math.round(stageWeight * taskWeight * 100) / 10000;

/** Das Gewicht einer Stufe in den Bereichen (0, wenn es sie nicht gibt). */
export const stageWeightIn = (sections: readonly ProductionTaskSection[], area: string, stage: string): number =>
    sections.find((section) => section.key === area)?.stages.find((entry) => entry.key === stage)?.weight ?? 0;

/**
 * Gerundete Anteile, die zusammen genau `target` ergeben: der Rundungsrest geht an den grössten
 * (sonst ergäben 7 × 14,29 % nicht 100 %).
 */
const roundedTo = (values: readonly number[], target: number): number[] => {
    const rounded = values.map(roundPercent);
    if (!rounded.length) return rounded;
    const rest = roundPercent(target - rounded.reduce((sum, value) => sum + value, 0));
    if (rest !== 0) {
        const largest = rounded.reduce((best, value, index) => (value > (rounded[best] ?? 0) ? index : best), 0);
        rounded[largest] = roundPercent((rounded[largest] ?? 0) + rest);
    }
    return rounded;
};

/** Eine gespeicherte Aufgabe: Bereich, Stufe, Anteil am Bereich, Gewicht in der Stufe (NULL = von vorher). */
export interface StoredTaskWeight {
    area: string;
    stage: string;
    sectionShare: number;
    stageWeight: number | null;
}

/**
 * Die Gewichte aus der Datenbank: die Bereiche mit den Gewichten ihrer Stufen und je Aufgabe
 * (in der Reihenfolge der Zeilen) ihr Gewicht in der Stufe. Gespeichertes gilt; was fehlt,
 * wird aus den Anteilen am Bereich abgeleitet (siehe oben).
 */
export const resolveTaskWeights = (
    sections: readonly ProductionTaskSection[],
    stageWeightsStored: boolean,
    rows: readonly StoredTaskWeight[],
): { sections: ProductionTaskSection[]; weights: number[] } => {
    const complete = stageWeightsStored && rows.every((row) => row.stageWeight !== null);
    if (complete) {
        return { sections: sections.map((section) => ({ ...section, stages: section.stages.map((stage) => ({ ...stage })) })), weights: rows.map((row) => roundPercent(row.stageWeight ?? 0)) };
    }
    // Abgeleitet: jede Stufe wiegt, was ihre Aufgaben am Bereich tragen …
    const key = (area: string, stage: string) => `${area}|${stage}`;
    const sums = new Map<string, number>();
    for (const row of rows) sums.set(key(row.area, row.stage), (sums.get(key(row.area, row.stage)) ?? 0) + row.sectionShare);
    const resolved = sections.map((section) => {
        const stageKeys = section.stages.map((stage) => stage.key);
        const derived = roundedTo(stageKeys.map((stage) => sums.get(key(section.key, stage)) ?? 0), roundPercent(stageKeys.reduce((sum, stage) => sum + (sums.get(key(section.key, stage)) ?? 0), 0)));
        return { ...section, stages: section.stages.map((stage, index) => ({ ...stage, weight: derived[index] ?? 0 })) };
    });
    // … und jede Aufgabe ihren Teil davon — je Stufe genau 100 %.
    const weights = rows.map(() => 0);
    const byStage = new Map<string, number[]>();
    rows.forEach((row, index) => byStage.set(key(row.area, row.stage), [...(byStage.get(key(row.area, row.stage)) ?? []), index]));
    for (const [stageKey, indexes] of byStage) {
        const total = sums.get(stageKey) ?? 0;
        if (total <= 0) continue;
        const parts = roundedTo(indexes.map((index) => ((rows[index]?.sectionShare ?? 0) / total) * 100), 100);
        indexes.forEach((index, position) => { weights[index] = parts[position] ?? 0; });
    }
    return { sections: resolved, weights };
};

/**
 * Aufgaben mit Anteilen am BEREICH (ein älterer Browserstand, das Beispiel) in das neue Mass:
 * Stufen erhalten die Summe ihrer Aufgaben, Aufgaben ihren Teil der Stufe.
 */
export const fromSectionShares = <T extends { area: string; stage: string; weight: number }>(
    sections: readonly ProductionTaskSection[],
    tasks: readonly T[],
): { sections: ProductionTaskSection[]; tasks: T[] } => {
    const { sections: resolved, weights } = resolveTaskWeights(
        sections,
        false,
        tasks.map((task) => ({ area: task.area, stage: task.stage, sectionShare: task.weight, stageWeight: null })),
    );
    return { sections: resolved, tasks: tasks.map((task, index) => ({ ...task, weight: weights[index] })) };
};

/**
 * Eine gespeicherte Aufgabe in den Bereichen ihrer Vorlage: ein unbekannter
 * Bereich fällt auf den ersten, eine unbekannte Stufe auf ihr Gegenstück oder
 * die erste des Bereichs — damit keine Aufgabe unsichtbar wird.
 */
export const placeTask = (
    sections: readonly ProductionTaskSection[],
    area: string,
    stage: string,
): { area: string; stage: string } => {
    const section = sections.find((entry) => entry.key === area) ?? sections[0];
    if (!section) return { area, stage };
    return { area: section.key, stage: stageOfSection(section, stage) ?? section.stages[0]?.key ?? stage };
};

/* ── Unteraufgaben ──────────────────────────────────────────────────────── */

/** Heute als Kalendertag (UTC) — der Tag des Anlegens, wenn keiner mitkommt. */
export const today = (): string => new Date().toISOString().slice(0, 10);

/** Ein mitgeschickter Tag des Anlegens gilt — aber nie einer in der Zukunft. */
const createdDayFrom = (value: unknown): string => {
    const day = dayFrom(value);
    const now = today();
    return day && day <= now ? day : now;
};

/** Die Dateien einer Unteraufgabe aus der Datenbank; Unlesbares fällt heraus. */
const filesFrom = (value: unknown): ProductionSubtaskFile[] => {
    if (!Array.isArray(value)) return [];
    const list: ProductionSubtaskFile[] = [];
    for (const raw of value) {
        const row = objectOf(raw);
        const id = typeof row.id === 'string' ? row.id : '';
        const ref = typeof row.ref === 'string' ? row.ref : '';
        if (!SUBTASK_ID.test(id) || !ref || list.some((entry) => entry.id === id)) continue;
        // Ältere Dateien (ohne Fassung) sind Fassung 1 ihrer eigenen Gruppe.
        const groupId = typeof row.groupId === 'string' && SUBTASK_ID.test(row.groupId) ? row.groupId : id;
        const version = typeof row.version === 'number' && Number.isInteger(row.version) && row.version > 0 ? row.version : 1;
        list.push({
            id,
            ref,
            groupId,
            version,
            revisionNote: text(row.revisionNote, 500) || null,
            name: text(row.name, 200) || 'file',
            type: typeof row.type === 'string' ? row.type : 'application/octet-stream',
            size: typeof row.size === 'number' && Number.isFinite(row.size) ? row.size : 0,
            uploadedById: typeof row.uploadedById === 'string' ? row.uploadedById : null,
            uploadedByName: text(row.uploadedByName, 120) || null,
            uploadedAt: typeof row.uploadedAt === 'string' ? row.uploadedAt : '',
            analysis: fileAnalysisFrom(row.analysis),
        });
    }
    return list;
};

/* ── Die Standards als PDF (01.10.2026) ─────────────────────────────────────── */

/** So sieht ein Verweis in die Ablage der Standards aus: Art, Firma, Monat, Zufallsname. */
const STANDARDS_REF = /^(?:local|r2):production-task-standards\/([A-Za-z0-9_-]+)\/[0-9-]+\/[0-9a-f-]{36}\.pdf$/;
/** So gross darf das PDF der Standards sein (zusammen mit dem geprüften PDF unter der Grenze der KI). */
export const STANDARDS_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Gehört dieser Verweis in die Ablage der Standards DIESER Firma? Sonst wird nichts gelesen. */
export const isStandardsRefOf = (ref: string, tenantId: string): boolean =>
    STANDARDS_REF.exec(ref)?.[1] === String(tenantId).replace(/[^a-zA-Z0-9_-]/g, '_');

/** Das PDF der Standards aus Datenbank oder Anfrage — nur mit «Document»; ein fremder Verweis fällt weg. */
const standardsFileFrom = (value: unknown, requiresDocument: boolean): ProductionStandardsFile | null => {
    if (!requiresDocument) return null;
    const row = objectOf(value);
    const ref = typeof row.ref === 'string' ? row.ref : '';
    if (!STANDARDS_REF.test(ref)) return null;
    return {
        ref,
        name: text(row.name, 200) || 'standards.pdf',
        size: typeof row.size === 'number' && Number.isFinite(row.size) ? row.size : 0,
        uploadedAt: typeof row.uploadedAt === 'string' ? row.uploadedAt : '',
    };
};

/** Trägt die Unteraufgabe Standards — Text, PDF oder beides? */
export const hasDocumentStandards = (subtask: Pick<ProductionSubtask, 'requiresDocument' | 'documentStandards' | 'documentStandardsFile'>): boolean =>
    subtask.requiresDocument && Boolean(subtask.documentStandards || subtask.documentStandardsFile);

/* ── KI-Prüfung der PDFs gegen die Standards (01.10.2026) ──────────────────── */

const ANALYSIS_STATUSES = new Set(['QUEUED', 'RUNNING', 'DONE', 'FAILED']);
const ANALYSIS_VERDICTS = new Set(['PASS', 'FAIL', 'UNCLEAR']);
const ANALYSIS_RESULTS = new Set(['MET', 'NOT_MET', 'UNCLEAR']);
/** Höchstens so viele geprüfte Standards je Datei, so lang ein Grund, so lang die Zusammenfassung. */
export const FILE_ANALYSIS_LIMITS = { checks: 40, standard: 300, reason: 600, summary: 1200 } as const;

/** Die Prüfung einer Datei aus der Datenbank — Unlesbares heisst «nie geprüft». */
const fileAnalysisFrom = (value: unknown): ProductionFileAnalysis | null => {
    const row = objectOf(value);
    if (!ANALYSIS_STATUSES.has(String(row.status)) || typeof row.requestedAt !== 'string') return null;
    const checks = Array.isArray(row.checks) ? row.checks : [];
    return {
        status: row.status as ProductionFileAnalysis['status'],
        standards: multilineText(row.standards, PRODUCTION_TASK_LIMITS.documentStandards),
        standardsFileRef: typeof row.standardsFileRef === 'string' && STANDARDS_REF.test(row.standardsFileRef) ? row.standardsFileRef : null,
        requestedAt: row.requestedAt,
        finishedAt: typeof row.finishedAt === 'string' ? row.finishedAt : null,
        verdict: ANALYSIS_VERDICTS.has(String(row.verdict)) ? row.verdict as ProductionFileAnalysis['verdict'] : null,
        summary: multilineText(row.summary, FILE_ANALYSIS_LIMITS.summary) || null,
        checks: checks.slice(0, FILE_ANALYSIS_LIMITS.checks).map((raw) => objectOf(raw)).map((check) => ({
            standard: text(check.standard, FILE_ANALYSIS_LIMITS.standard),
            result: (ANALYSIS_RESULTS.has(String(check.result)) ? check.result : 'UNCLEAR') as ProductionFileAnalysis['checks'][number]['result'],
            reason: multilineText(check.reason, FILE_ANALYSIS_LIMITS.reason),
        })).filter((check) => check.standard),
        model: text(row.model, 60) || null,
        errorCode: text(row.errorCode, 60) || null,
        // Ältere Prüfungen kennen beides nicht (02.10.2026): ohne Notiz, keine Fotogruppe.
        note: multilineText(row.note, SUBMISSION_NOTE_MAX) || null,
        groupFileIds: Array.isArray(row.groupFileIds)
            ? row.groupFileIds.filter((id): id is string => typeof id === 'string' && SUBTASK_ID.test(id)).slice(0, SUBTASK_FILE_LIMITS.files)
            : [],
    };
};

/** So lange darf eine Prüfung warten oder laufen — danach ist sie verloren (z. B. Neustart des Servers). */
const ANALYSIS_STALE_MS = 15 * 60 * 1000;

/** Wartet oder läuft sie noch wirklich? Eine liegengebliebene gilt als gescheitert. */
export const isAnalysisActive = (analysis: ProductionFileAnalysis | null, now = Date.now()): boolean =>
    Boolean(analysis && (analysis.status === 'QUEUED' || analysis.status === 'RUNNING')
        && now - Date.parse(analysis.requestedAt) < ANALYSIS_STALE_MS);

/** Eine liegengebliebene Prüfung, wie die Oberfläche sie sieht: gescheitert, «unterbrochen». */
export const analysisAsSeen = (analysis: ProductionFileAnalysis | null, now = Date.now()): ProductionFileAnalysis | null => {
    if (!analysis || analysis.status === 'DONE' || analysis.status === 'FAILED' || isAnalysisActive(analysis, now)) return analysis;
    return { ...analysis, status: 'FAILED', errorCode: 'ANALYSIS_INTERRUPTED' };
};

/**
 * Welche PDFs beim Schicken zur Freigabe geprüft werden: je Datei die aktuelle
 * Fassung — sofern die Unteraufgabe «Document» und Standards trägt und die
 * Fassung nicht schon gegen DIESELBEN Standards geprüft ist (gescheitert zählt nicht).
 */
export const filesToAnalyse = (subtask: ProductionSubtask): string[] => {
    if (!hasDocumentStandards(subtask)) return [];
    const standards = subtask.documentStandards ?? '';
    const standardsFileRef = subtask.documentStandardsFile?.ref ?? null;
    // Die Notiz der Einsendung (und der Betrag) liest die KI mit (02.10.2026) — eine andere Notiz heisst neu prüfen.
    const note = analysisNoteOf(subtask);
    const stale = (file: ProductionSubtaskFile) => !file.analysis
        || file.analysis.standards !== standards
        || file.analysis.standardsFileRef !== standardsFileRef
        || file.analysis.note !== note
        || analysisAsSeen(file.analysis)?.status === 'FAILED';
    const pdfs = latestFilesOf(subtask.files)
        .filter((file) => file.type === 'application/pdf')
        .filter(stale)
        .map((file) => file.id);
    // Die Fotos (nur mit «Fotoğraf yeterli») zusammen: neu, sobald eines fehlt, anders geprüft ist oder die Gruppe sich änderte.
    const group = photoGroupOf(subtask);
    const groupKey = [...group].sort().join(',');
    const photosStale = group.some((id) => {
        const file = subtask.files.find((entry) => entry.id === id);
        return !file || stale(file) || [...(file.analysis?.groupFileIds ?? [])].sort().join(',') !== groupKey;
    });
    return [...pdfs, ...(photosStale ? group : [])];
};

/** Je Datei die aktuelle Fassung (die höchste ihrer Gruppe). */
const latestFilesOf = (files: readonly ProductionSubtaskFile[]): ProductionSubtaskFile[] => {
    const latest = new Map<string, ProductionSubtaskFile>();
    for (const file of files) {
        const known = latest.get(file.groupId);
        if (!known || file.version > known.version) latest.set(file.groupId, file);
    }
    return [...latest.values()];
};

/** So viele Fotos gehen höchstens in EINE Prüfung (02.10.2026) — die neuesten. */
export const PHOTO_GROUP_MAX = 10;

/**
 * Die Fotos, die zusammen geprüft werden (02.10.2026: «Fotoğraflar TEK istekte birlikte analiz
 * edilir»): nur mit «Fotoğraf yeterli», je Datei die aktuelle Fassung, die neuesten zehn — in der
 * Reihenfolge des Hochladens.
 */
export const photoGroupOf = (subtask: Pick<ProductionSubtask, 'photoAllowed' | 'files'>): string[] => {
    if (!subtask.photoAllowed) return [];
    return latestFilesOf(subtask.files)
        .filter((file) => isSubtaskPhotoType(file.type))
        .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt))
        .slice(0, PHOTO_GROUP_MAX)
        .reverse()
        .map((file) => file.id);
};

/** Diese Dateien warten auf die Prüfung — gegen die heutigen Standards der Unteraufgabe. */
export const withQueuedAnalyses = (subtask: ProductionSubtask, fileIds: readonly string[], requestedAt: string): ProductionSubtask => {
    const wanted = new Set(fileIds);
    const standards = subtask.documentStandards ?? '';
    const standardsFileRef = subtask.documentStandardsFile?.ref ?? null;
    const note = analysisNoteOf(subtask);
    // Die Fotos unter den Dateien bilden EINE Gruppe (02.10.2026); ein PDF steht für sich.
    const photoIds = fileIds.filter((id) => isSubtaskPhotoType(subtask.files.find((file) => file.id === id)?.type ?? ''));
    return {
        ...subtask,
        files: subtask.files.map((file) => (!wanted.has(file.id) ? file : {
            ...file,
            analysis: {
                status: 'QUEUED',
                standards,
                standardsFileRef,
                requestedAt,
                finishedAt: null,
                verdict: null,
                summary: null,
                checks: [],
                model: null,
                errorCode: null,
                note,
                groupFileIds: isSubtaskPhotoType(file.type) ? photoIds : [],
            },
        })),
    };
};

/**
 * Ein Schritt der Prüfung einer Datei — nur, solange DIESER Auftrag gilt (dieselbe
 * `requestedAt`): ein neuerer Auftrag oder eine entfernte Datei bleiben unberührt.
 */
export const withFileAnalysis = (
    subtask: ProductionSubtask,
    fileId: string,
    requestedAt: string,
    patch: Partial<ProductionFileAnalysis>,
): ProductionSubtask => ({
    ...subtask,
    files: subtask.files.map((file) => (file.id !== fileId || file.analysis?.requestedAt !== requestedAt
        ? file
        : { ...file, analysis: { ...file.analysis, ...patch } })),
});

/** Wie `withFileAnalysis`, für mehrere Dateien zugleich — derselbe Bericht an jedem Foto der Gruppe (02.10.2026). */
export const withFileAnalyses = (
    subtask: ProductionSubtask,
    fileIds: readonly string[],
    requestedAt: string,
    patch: Partial<ProductionFileAnalysis>,
): ProductionSubtask => fileIds.reduce((current, fileId) => withFileAnalysis(current, fileId, requestedAt, patch), subtask);

/**
 * Die Freigabe-Checkliste einer Unteraufgabe (28.09.2026: «add Approval
 * Checklist after they select approval checkbox»). Nur mit «Approval» —
 * ohne fällt sie weg; leere Punkte fallen heraus.
 */
const approvalChecklistFrom = (value: unknown, requiresApproval: boolean): ProductionSubtaskChecklistItem[] => {
    if (!requiresApproval || !Array.isArray(value)) return [];
    const list: ProductionSubtaskChecklistItem[] = [];
    for (const raw of value) {
        if (list.length >= PRODUCTION_TASK_LIMITS.checklistItems) break;
        const row = objectOf(raw);
        const itemText = text(row.text, PRODUCTION_TASK_LIMITS.checklistItemText);
        if (!itemText) continue;
        const given = typeof row.id === 'string' ? row.id.trim() : '';
        const id = SUBTASK_ID.test(given) && !list.some((entry) => entry.id === given) ? given : randomKey('c');
        list.push({ id, text: itemText });
    }
    return list;
};

/**
 * Ein Punkt mehr in der Freigabe-Checkliste (28.09.2026: «admins should be
 * able to add items to the checklist through the approve files modal»).
 * Leer oder zu viele → Fehler. Öffnet die Unteraufgabe NICHT wieder: wer
 * prüft, ergänzt, was er gerade selbst prüft.
 */
export const withChecklistItem = (subtask: ProductionSubtask, rawText: unknown): ProductionSubtask => {
    const itemText = text(rawText, PRODUCTION_TASK_LIMITS.checklistItemText);
    if (!itemText) throw productionTaskError('CHECKLIST_ITEM_REQUIRED', 'Bitte einen Text für den Punkt eingeben.');
    if (subtask.approvalChecklist.length >= PRODUCTION_TASK_LIMITS.checklistItems) {
        throw productionTaskError('CHECKLIST_TOO_MANY', 'Zu viele Punkte.', { status: 409, params: { max: PRODUCTION_TASK_LIMITS.checklistItems } });
    }
    return { ...subtask, approvalChecklist: [...subtask.approvalChecklist, { id: randomKey('c'), text: itemText }] };
};

/**
 * Gruppe und Nummer einer neuen Datei (28.09.2026): ohne `revisionOf` eine neue Datei
 * (eigene Gruppe, Fassung 1); mit `revisionOf` die nächste Fassung derselben Datei —
 * die Kennung muss eine Datei DIESER Unteraufgabe sein.
 */
export const fileVersionFor = (
    files: ReadonlyArray<Pick<ProductionSubtaskFile, 'id' | 'groupId' | 'version'>>,
    newId: string,
    revisionOf: string | null,
): { groupId: string; version: number } => {
    if (!revisionOf) return { groupId: newId, version: 1 };
    const base = files.find((file) => file.id === revisionOf);
    if (!base) throw productionTaskError('FILE_NOT_FOUND', 'Die Datei für die neue Fassung gibt es hier nicht.', { status: 404 });
    const newest = files.filter((file) => file.groupId === base.groupId).reduce((max, file) => Math.max(max, file.version), 0);
    return { groupId: base.groupId, version: newest + 1 };
};

/** Neue Kennung einer Datei an einer Unteraufgabe. */
export const newSubtaskFileId = (): string => randomKey('f');

/** Höchstens so viele Dateien je Unteraufgabe; so gross darf eine sein. */
export const SUBTASK_FILE_LIMITS = { files: 20, bytes: 25 * 1024 * 1024 } as const;

/** Fotos, die mit «Fotoğraf yeterli» an eine Unteraufgabe dürfen (02.10.2026). */
export const SUBTASK_PHOTO_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
export const isSubtaskPhotoType = (type: string): boolean => SUBTASK_PHOTO_TYPES.includes(type);

/** So lang darf die kurze Notiz der Einsendung sein (02.10.2026) — Messwerte brauchen Platz. */
export const SUBMISSION_NOTE_MAX = 1000;

/** Der höchste Betrag beim Einsenden (CHF, 02.10.2026). */
export const SUBTASK_FEE_MAX = 100_000_000;

/**
 * Ein Betrag (CHF) aus der Datenbank oder einer Anfrage: Zahl oder Text mit Punkt/Komma, 0 bis
 * `SUBTASK_FEE_MAX`, auf Rappen gerundet. Leer → null; Unlesbares → undefined.
 */
export const feeFrom = (value: unknown): number | null | undefined => {
    if (value === undefined || value === null || value === '') return null;
    const raw = typeof value === 'number'
        ? value
        : typeof value === 'string' ? Number(value.replace(/['’\s]/g, '').replace(',', '.')) : Number.NaN;
    if (!Number.isFinite(raw) || raw < 0 || raw > SUBTASK_FEE_MAX) return undefined;
    return Math.round(raw * 100) / 100;
};

/**
 * Was die KI neben den Dateien liest (02.10.2026): die kurze Notiz der Einsendung — mit «Ücret
 * girilsin» davor der Betrag. Ändert sich eins davon, gilt eine Prüfung nicht mehr.
 */
export const analysisNoteOf = (subtask: Pick<ProductionSubtask, 'submissionNote' | 'fee' | 'feeRequired'>): string | null => {
    const fee = subtask.feeRequired && subtask.fee !== null ? `Ücret (CHF): ${subtask.fee.toFixed(2)}` : null;
    return [fee, subtask.submissionNote].filter(Boolean).join('\n') || null;
};

/** Darf diese Dateiart an die Unteraufgabe? PDF immer; ein Foto nur mit «Fotoğraf yeterli» (02.10.2026). */
export const subtaskAcceptsType = (subtask: Pick<ProductionSubtask, 'photoAllowed'>, type: string): boolean =>
    type === 'application/pdf' || (subtask.photoAllowed && isSubtaskPhotoType(type));

/**
 * Gilt das Dokument einer Unteraufgabe als da? Ein PDF («görev PDF'siz kapanmaz») — mit
 * «Fotoğraf yeterli» genügt auch ein Foto (02.10.2026).
 */
export const hasSubtaskDocument = (subtask: Pick<ProductionSubtask, 'files'> & { photoAllowed?: boolean }): boolean =>
    subtask.files.some((file) => file.type === 'application/pdf' || (subtask.photoAllowed === true && isSubtaskPhotoType(file.type)));

/** Eine Aufgabe, wie die Sperre sie liest. */
type PriorStepTask = Pick<ProductionDeviceTask, 'id' | 'area' | 'stage' | 'code' | 'name' | 'status' | 'sortOrder'> & {
    subtasks: ReadonlyArray<Pick<ProductionSubtask, 'id' | 'name' | 'status'>>;
};

/**
 * «Sistem kilidi» (02.10.2026, OCC-Standard S. 7 «Sevke Hazır / Gönderildi seçilemez …»): was VOR
 * dieser Unteraufgabe noch nicht erledigt ist. Davor heisst: im eigenen Bereich die früheren
 * Stufen (Reihenfolge des Wegs), in derselben Stufe die früheren Aufgaben, in derselben Aufgabe die
 * früheren Unteraufgaben — und jeder andere Bereich ganz (die Elektrik bis zu ihrem Final:
 * Schema, Seriennummer, QR). Eine Aufgabe ohne Unteraufgaben zählt mit ihrem eigenen Stand.
 * Antwort: «M-12.1 Soğutma devresi basınç testi» … in der Reihenfolge des Wegs.
 */
export const openPriorSteps = (
    sections: readonly ProductionTaskSection[],
    tasks: readonly PriorStepTask[],
    taskId: string,
    subtaskId: string,
): string[] => {
    const target = tasks.find((task) => task.id === taskId);
    if (!target) return [];
    const sectionAt = (area: string): number => {
        const index = sections.findIndex((section) => section.key === area);
        return index < 0 ? sections.length : index;
    };
    const stageAt = (area: string, stage: string): number => {
        const index = sections.find((section) => section.key === area)?.stages.findIndex((entry) => entry.key === stage) ?? -1;
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    const ordered = tasks
        .map((task, index) => ({ task, index }))
        .sort((left, right) => sectionAt(left.task.area) - sectionAt(right.task.area)
            || stageAt(left.task.area, left.task.stage) - stageAt(right.task.area, right.task.stage)
            || left.task.sortOrder - right.task.sortOrder
            || left.index - right.index)
        .map(({ task }) => task);
    const position = ordered.indexOf(target);
    const targetStage = stageAt(target.area, target.stage);
    const open: string[] = [];
    const openSubtasks = (task: PriorStepTask, count: number) => task.subtasks.slice(0, count).forEach((subtask, index) => {
        if (subtask.status !== 'DONE') open.push(`${task.code}.${index + 1} ${subtask.name}`);
    });
    ordered.forEach((task, at) => {
        // In der eigenen Aufgabe: nur die Unteraufgaben darüber.
        if (task === target) {
            openSubtasks(task, Math.max(0, task.subtasks.findIndex((subtask) => subtask.id === subtaskId)));
            return;
        }
        const stage = stageAt(task.area, task.stage);
        const earlier = task.area !== target.area || stage < targetStage || (stage === targetStage && at < position);
        if (!earlier) return;
        if (task.subtasks.length) openSubtasks(task, task.subtasks.length);
        else if (task.status !== 'DONE') open.push(`${task.code} ${task.name}`);
    });
    return open;
};

/** Die offenen Schritte davor als Fehler (409) — höchstens acht genannt, dazu die Zahl. */
export const priorStepsError = (open: readonly string[]): ProductionTaskError => {
    const shown = open.slice(0, 8).join(' · ') + (open.length > 8 ? ' …' : '');
    return productionTaskError('PRIOR_STEPS_OPEN', `Erst die Schritte davor abschliessen: ${shown}`, {
        status: 409,
        params: { count: open.length, steps: shown },
    });
};

const subtaskOf = (
    row: Record<string, unknown>,
    id: string,
    name: string,
    startDate: string | null,
    dueDate: string | null,
    createdAt: string | null,
    weight: number | null,
): ProductionSubtask => ({
    id,
    name,
    createdAt,
    weight,
    startDate,
    dueDate,
    assigneeIds: assigneeIdsFrom(row.assigneeIds),
    requiresDocument: row.requiresDocument === true,
    photoAllowed: row.requiresDocument === true && row.photoAllowed === true,
    feeRequired: row.feeRequired === true,
    priorStepsRequired: row.priorStepsRequired === true,
    requiresApproval: row.requiresApproval === true,
    approvalChecklist: approvalChecklistFrom(row.approvalChecklist, row.requiresApproval === true),
    documentStandards: row.requiresDocument === true
        ? multilineText(row.documentStandards, PRODUCTION_TASK_LIMITS.documentStandards) || null
        : null,
    documentStandardsFile: standardsFileFrom(row.documentStandardsFile, row.requiresDocument === true),
    status: statusFrom(row.status),
    files: filesFrom(row.files),
    completedById: typeof row.completedById === 'string' ? row.completedById : null,
    completedByName: text(row.completedByName, 120) || null,
    completedAt: typeof row.completedAt === 'string' ? row.completedAt : null,
    completionNote: text(row.completionNote, 500) || null,
    submissionNote: multilineText(row.submissionNote, SUBMISSION_NOTE_MAX) || null,
    fee: row.feeRequired === true ? feeFrom(row.fee) ?? null : null,
    revisionById: typeof row.revisionById === 'string' ? row.revisionById : null,
    revisionByName: text(row.revisionByName, 120) || null,
    revisionAt: typeof row.revisionAt === 'string' ? row.revisionAt : null,
    revisionNote: text(row.revisionNote, 500) || null,
    revisionHistory: revisionHistoryFrom(row.revisionHistory),
});

/** Der Verlauf der Rückgaben aus der Datenbank (höchstens 50, älteste zuerst); Unlesbares fällt heraus. */
const revisionHistoryFrom = (value: unknown): ProductionSubtask['revisionHistory'] => {
    if (!Array.isArray(value)) return [];
    return value
        .map((raw) => objectOf(raw))
        .filter((row) => typeof row.at === 'string' && row.at)
        .slice(-50)
        .map((row) => ({
            byId: typeof row.byId === 'string' ? row.byId : null,
            byName: text(row.byName, 120) || null,
            at: row.at as string,
            note: text(row.note, 500) || null,
        }));
};

/**
 * Was am Gerät dem Server gehört (Stand, Dateien, Abschluss) — eine Anfrage
 * bringt es nie mit; die Anpassung am Gerät behält es aus der Datenbank.
 */
export const withoutDeviceRecord = (subtask: ProductionSubtask): ProductionSubtask => ({
    ...subtask,
    status: 'TODO',
    files: [],
    completedById: null,
    completedByName: null,
    completedAt: null,
    completionNote: null,
    submissionNote: null,
    fee: null,
    revisionById: null,
    revisionByName: null,
    revisionAt: null,
    revisionNote: null,
    revisionHistory: [],
});

/**
 * Kommt durch die Anpassung am Gerät eine Pflicht DAZU (28.09.2026: «it
 * didn't require a document but admin adds it, or adds a new checklist
 * item»)? «Document» oder «Approval» neu angehakt, oder ein Punkt der
 * Checkliste neu bzw. anders formuliert. Weniger Pflichten zählen nicht.
 */
export const requirementsAdded = (before: ProductionSubtask, after: ProductionSubtask): boolean => {
    if (after.requiresDocument && !before.requiresDocument) return true;
    if (after.requiresApproval && !before.requiresApproval) return true;
    if (after.requiresDocument && before.photoAllowed && !after.photoAllowed) return true;
    // Ein Betrag wird verlangt, und es gibt noch keinen (02.10.2026).
    if (after.feeRequired && !before.feeRequired && before.fee === null) return true;
    const earlier = new Map(before.approvalChecklist.map((item) => [item.id, item.text]));
    return after.approvalChecklist.some((item) => earlier.get(item.id) !== item.text);
};

/**
 * Eine angepasste Unteraufgabe mit dem, was dem Server gehört: Stand,
 * Dateien, Freigabe und Rückgabe bleiben aus der Datenbank — die Anfrage
 * setzt sie nie. Kommt eine Pflicht dazu, beginnt sie von vorn: offen (▶
 * wieder da), ohne Freigabe/Sperre und ohne alte Rückgabe; die Dateien bleiben.
 */
export const mergeDeviceRecord = (edited: ProductionSubtask, kept: ProductionSubtask): ProductionSubtask => {
    const merged: ProductionSubtask = {
        ...edited,
        status: kept.status,
        files: kept.files,
        completedById: kept.completedById,
        completedByName: kept.completedByName,
        completedAt: kept.completedAt,
        completionNote: kept.completionNote,
        submissionNote: kept.submissionNote,
        fee: edited.feeRequired ? kept.fee : null,
        revisionById: kept.revisionById,
        revisionByName: kept.revisionByName,
        revisionAt: kept.revisionAt,
        revisionNote: kept.revisionNote,
        revisionHistory: kept.revisionHistory,
    };
    // Auch beim Neubeginn bleiben Dateien und der Verlauf der Rückgaben (er ist Geschichte, kein Stand).
    return requirementsAdded(kept, edited)
        ? { ...withoutDeviceRecord(merged), files: kept.files, revisionHistory: kept.revisionHistory }
        : merged;
};

/** Eine durch neue Pflichten wieder geöffnete Unteraufgabe — für die Nachricht an die Leute der Unteraufgabe. */
export interface ReopenedSubtask {
    code: string;
    name: string;
    area: string;
    stage: string;
    recipients: string[];
}

type TaskWithSubtasks = { id: string; code: string; area: string; stage: string; assigneeIds: string[]; subtasks: ProductionSubtask[] };

/**
 * Welche schon begonnenen Unteraufgaben hat die Anpassung wieder geöffnet
 * (28.09.2026: «the assignee should check the subtask and complete it
 * again»)? Nur was vorher nicht mehr offen war — eine offene bleibt offen.
 */
export const reopenedSubtasks = (before: readonly TaskWithSubtasks[], after: readonly TaskWithSubtasks[]): ReopenedSubtask[] => {
    const earlier = new Map(before.map((task) => [task.id, new Map(task.subtasks.map((subtask) => [subtask.id, subtask]))]));
    return after.flatMap((task) => task.subtasks.flatMap((subtask, index) => {
        const previous = earlier.get(task.id)?.get(subtask.id);
        if (!previous || previous.status === 'TODO' || !requirementsAdded(previous, subtask)) return [];
        return [{ code: `${task.code}.${index + 1}`, name: subtask.name, area: task.area, stage: task.stage, recipients: subtask.assigneeIds }];
    }));
};

/** Unteraufgaben aus der Datenbank; leere fallen heraus. */
export const subtasksFrom = (value: unknown): ProductionSubtask[] => {
    if (!Array.isArray(value)) return [];
    const list: ProductionSubtask[] = [];
    value.forEach((raw, index) => {
        const row = objectOf(raw);
        const name = text(row.name, PRODUCTION_TASK_LIMITS.subtaskName);
        if (!name || list.length >= PRODUCTION_TASK_LIMITS.subtasks) return;
        const given = typeof row.id === 'string' ? row.id : '';
        const id = SUBTASK_ID.test(given) && !list.some((entry) => entry.id === given) ? given : `u-${index + 1}`;
        list.push(subtaskOf(row, id, name, dayFrom(row.startDate) ?? null, dayFrom(row.dueDate) ?? null, dayFrom(row.createdAt) ?? null, percentFrom(row.weight)));
    });
    return list;
};

/**
 * Unteraufgaben aus einer Anfrage — null, wenn es zu viele sind, keine Liste
 * oder ein Gewicht bzw. (am Gerät) ein Tag unlesbar ist.
 */
const subtasksInputFrom = (value: unknown, withDates: boolean): ProductionSubtask[] | null => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > PRODUCTION_TASK_LIMITS.subtasks) return null;
    const list: ProductionSubtask[] = [];
    for (const raw of value) {
        const row = objectOf(raw);
        const name = text(row.name, PRODUCTION_TASK_LIMITS.subtaskName);
        // Eine leere Zeile ist keine Unteraufgabe.
        if (!name) continue;
        const given = typeof row.id === 'string' ? row.id.trim() : '';
        const id = SUBTASK_ID.test(given) && !list.some((entry) => entry.id === given) ? given : randomKey('u');
        // Leer = ohne Gewicht; eine Zahl ausserhalb 0…100 ist ein Fehler.
        const empty = row.weight === undefined || row.weight === null || row.weight === '';
        const weight = empty ? null : percentFrom(row.weight);
        if (!empty && weight === null) return null;
        // Eine Vorlage trägt keine Tage (28.09.2026) — erst die Kopie am Gerät.
        const startDate = withDates ? dayFrom(row.startDate) : null;
        const dueDate = withDates ? dayFrom(row.dueDate) : null;
        if (startDate === undefined || dueDate === undefined) return null;
        // Stand, Dateien und Abschluss setzt nie die Anfrage — am Gerät behält
        // der Server sie (replaceTasks), in der Vorlage beginnt alles offen.
        list.push(withoutDeviceRecord(subtaskOf(row, id, name, startDate, dueDate, createdDayFrom(row.createdAt), weight)));
    }
    return list;
};

/* ── Stand ──────────────────────────────────────────────────────────────── */

export const PRODUCTION_TASK_STATUSES: readonly ProductionTaskStatus[] = ['TODO', 'IN_PROGRESS', 'REVISION', 'PENDING', 'DONE'];

/** In Arbeit — auch zur Überarbeitung zurückgegeben (REVISION): von hier aus wird abgeschlossen. */
export const isWorkingStatus = (status: ProductionTaskStatus): boolean => status === 'IN_PROGRESS' || status === 'REVISION';

export const isProductionTaskStatus = (value: unknown): value is ProductionTaskStatus =>
    typeof value === 'string' && (PRODUCTION_TASK_STATUSES as readonly string[]).includes(value);

/** Der Stand aus der Datenbank — Unbekanntes gilt als offen. */
export const statusFrom = (value: unknown): ProductionTaskStatus => (isProductionTaskStatus(value) ? value : 'TODO');

/**
 * Der Stand einer Aufgabe aus dem ihrer Unteraufgaben (28.09.2026): alle
 * erledigt → erledigt; alle erledigt oder wartend → wartet auf Freigabe;
 * eine begonnen → in Arbeit; sonst offen.
 * Ohne Unteraufgaben null — dann setzt man den Stand der Aufgabe selbst.
 */
export const statusOfSubtasks = (subtasks: ReadonlyArray<Pick<ProductionSubtask, 'status'>>): ProductionTaskStatus | null => {
    if (!subtasks.length) return null;
    if (subtasks.every((subtask) => subtask.status === 'DONE')) return 'DONE';
    // Alles fertig, aber noch nicht alles freigegeben: die Aufgabe wartet auf die Freigabe.
    if (subtasks.every((subtask) => subtask.status === 'DONE' || subtask.status === 'PENDING')) return 'PENDING';
    if (subtasks.some((subtask) => subtask.status !== 'TODO')) return 'IN_PROGRESS';
    return 'TODO';
};

/**
 * Die Gewichte der Unteraufgaben zusammen. Sie sind Anteile an ihrer Aufgabe
 * («10 means 10% of its parent», 28.09.2026) und ergeben zusammen höchstens
 * 100 % — eine einzelne höchstens den Rest. Wortgleich mit der Oberfläche.
 */
export const subtaskWeightSum = (subtasks: ReadonlyArray<Pick<ProductionSubtask, 'weight'>>): number =>
    roundPercent(subtasks.reduce((sum, subtask) => sum + (subtask.weight ?? 0), 0));


/**
 * Passen die Tage einer Aufgabe am Gerät? Der Beginn liegt nicht nach dem
 * Termin, und jede Unteraufgabe liegt innerhalb der Tage ihrer Aufgabe
 * («the subtask's due date can't be further than its parent's due date, and
 * the start date can't be older than its parent's starting date»). Leere
 * Tage binden nichts; `YYYY-MM-DD` ist als Text vergleichbar. Wortgleich
 * mit der Oberfläche.
 */
export const taskDatesProblem = (
    task: Pick<ProductionTaskDraft, 'startDate' | 'dueDate'>,
    subtasks: ReadonlyArray<Pick<ProductionSubtask, 'startDate' | 'dueDate'>>,
): 'dueDate' | 'subtasks' | null => {
    if (task.startDate && task.dueDate && task.startDate > task.dueDate) return 'dueDate';
    for (const subtask of subtasks) {
        if (subtask.startDate && subtask.dueDate && subtask.startDate > subtask.dueDate) return 'subtasks';
        for (const day of [subtask.startDate, subtask.dueDate]) {
            if (!day) continue;
            if (task.startDate && day < task.startDate) return 'subtasks';
            if (task.dueDate && day > task.dueDate) return 'subtasks';
        }
    }
    return null;
};

/* ── Kürzel ─────────────────────────────────────────────────────────────── */

/**
 * Das Kürzel-Präfix je Bereich — wortgleich mit der Oberfläche: M und E für
 * die festen, sonst der Anfang des Namens («Hidrolik» → H). Je Vorlage
 * eindeutig: ist der Buchstabe vergeben, werden es zwei («Montaj» → MO).
 */
export const sectionPrefixes = (sections: readonly Pick<ProductionTaskSection, 'key' | 'name'>[]): Map<string, string> => {
    const used = new Set<string>();
    const prefixes = new Map<string, string>();
    for (const section of sections) {
        const letters = section.key === 'MECHANICAL' ? 'M'
            : section.key === 'ELECTRICAL' ? 'E'
                : section.name.toLocaleUpperCase('tr-TR').replace(/[^\p{L}]/gu, '');
        const base = letters || 'T';
        let prefix = [base.slice(0, 1), base.slice(0, 2), base.slice(0, 3)].find((candidate) => !used.has(candidate));
        for (let number = 2; !prefix; number += 1) {
            if (!used.has(`${base.slice(0, 1)}${number}`)) prefix = `${base.slice(0, 1)}${number}`;
        }
        used.add(prefix);
        prefixes.set(section.key, prefix);
    }
    return prefixes;
};

export const taskCodeOf = (prefix: string, number: number): string => `${prefix}-${String(number).padStart(2, '0')}`;

/** Aufgaben ohne Kürzel bekommen das nächste freie ihres Bereichs (M-15 nach M-14). */
const fillMissingCodes = (sections: readonly ProductionTaskSection[], tasks: ProductionTaskDraft[]): void => {
    const prefixes = sectionPrefixes(sections);
    for (const task of tasks) {
        if (task.code) continue;
        const prefix = prefixes.get(task.area) ?? 'T';
        let number = 1;
        while (tasks.some((other) => other.code && sameTaskCode(other.code, taskCodeOf(prefix, number)))) number += 1;
        task.code = taskCodeOf(prefix, number);
    }
};

/* ── Eine Vorlage aus der Anfrage ──────────────────────────────────────── */

/** Die Bereiche einer Anfrage — streng: was sich nicht speichern lässt, ist ein Fehler. */
const sectionsInputFrom = (value: unknown[]): ProductionTaskSection[] => {
    if (value.length > PRODUCTION_TASK_LIMITS.sections) {
        throw productionTaskError('SECTIONS_TOO_MANY', `Höchstens ${PRODUCTION_TASK_LIMITS.sections} Bereiche je Vorlage.`, {
            params: { max: PRODUCTION_TASK_LIMITS.sections },
        });
    }
    const sections: ProductionTaskSection[] = [];
    value.forEach((raw, index) => {
        const row = objectOf(raw);
        const invalid = () => productionTaskError('SECTION_INVALID', `Bereich ${index + 1} ist ungültig.`, {
            params: { row: index + 1 },
        });
        const key = typeof row.key === 'string' ? row.key.trim() : '';
        if (!SECTION_KEY.test(key) || sections.some((section) => section.key === key)) throw invalid();
        const builtIn = isBuiltInArea(key);
        const name = builtIn ? '' : text(row.name, PRODUCTION_TASK_LIMITS.sectionName);
        if (!builtIn && !name) {
            throw productionTaskError('SECTION_NAME_REQUIRED', 'Jeder Bereich braucht einen Namen.', { params: { row: index + 1 } });
        }
        if (name && sections.some((section) => section.name && sameName(section.name, name))) {
            throw productionTaskError('SECTION_NAME_TAKEN', `Zwei Bereiche heissen «${name}».`, { status: 409, params: { name } });
        }
        const label = name || key;
        const share = percentFrom(row.share ?? 0);
        if (share === null) {
            throw productionTaskError('SHARES_INVALID', 'Der Anteil eines Bereichs muss zwischen 0 und 100 liegen.', {
                params: { area: label },
            });
        }
        const rawStages = Array.isArray(row.stages) ? row.stages : [];
        if (rawStages.length > PRODUCTION_TASK_LIMITS.stages) {
            throw productionTaskError('STAGES_TOO_MANY', `Höchstens ${PRODUCTION_TASK_LIMITS.stages} Stufen je Bereich.`, {
                params: { max: PRODUCTION_TASK_LIMITS.stages, section: label },
            });
        }
        const stages: ProductionTaskSectionStage[] = [];
        for (const rawStage of rawStages) {
            const stage = objectOf(rawStage);
            const stageKey = typeof stage.key === 'string' ? stage.key.trim() : '';
            if (!STAGE_KEY.test(stageKey) || RESERVED_STAGE_KEYS.has(stageKey) || stages.some((entry) => entry.key === stageKey)) {
                throw invalid();
            }
            const stageName = text(stage.name, PRODUCTION_TASK_LIMITS.stageName);
            // Nur eine feste Stufe darf ohne Namen kommen — ihr Name steht in der Übersetzung.
            if (!stageName && !isBuiltInStage(stageKey)) {
                throw productionTaskError('STAGE_NAME_REQUIRED', 'Jede Stufe braucht einen Namen.', { params: { section: label } });
            }
            if (stageName && stages.some((entry) => entry.name && sameName(entry.name, stageName))) {
                throw productionTaskError('STAGE_NAME_TAKEN', `Im Bereich «${label}» heissen zwei Stufen «${stageName}».`, {
                    status: 409,
                    params: { section: label, name: stageName },
                });
            }
            // Das Gewicht der Stufe im Bereich (30.09.2026) — fehlt es, kommt ein älterer Browserstand.
            const weight = percentFrom(stage.weight ?? 0);
            if (weight === null) {
                throw productionTaskError('STAGE_WEIGHT_INVALID', 'Das Gewicht einer Stufe muss zwischen 0 und 100 liegen.', {
                    params: { section: label, name: stageName || stageKey },
                });
            }
            stages.push({ key: stageKey, name: stageName, weight });
        }
        sections.push({ key, name, share, stages });
    });
    return sections;
};

/** Bringt die Anfrage die Gewichte der Stufen mit? — sonst ein älterer Browserstand (Anteile am Bereich). */
const requestHasStageWeights = (value: unknown): boolean =>
    Array.isArray(value) && value.some((raw) => {
        const stages = objectOf(raw).stages;
        return Array.isArray(stages) && stages.some((stage) => objectOf(stage).weight !== undefined);
    });

/**
 * Die Gewichte der Stufen der Kopie am Gerät neu (30.09.2026) — nur für Stufen, die es gibt;
 * Namen, Reihenfolge und Anteile bleiben. Ohne Angabe bleibt alles, wie es ist.
 */
export const withStageWeights = (sections: readonly ProductionTaskSection[], value: unknown): ProductionTaskSection[] => {
    if (!Array.isArray(value)) return sections.map((section) => ({ ...section }));
    const given = new Map<string, unknown>();
    for (const raw of value) {
        const row = objectOf(raw);
        for (const rawStage of Array.isArray(row.stages) ? row.stages : []) {
            const stage = objectOf(rawStage);
            if (typeof row.key === 'string' && typeof stage.key === 'string' && stage.weight !== undefined) {
                given.set(`${row.key}|${stage.key}`, stage.weight);
            }
        }
    }
    return sections.map((section) => ({
        ...section,
        stages: section.stages.map((stage) => {
            if (!given.has(`${section.key}|${stage.key}`)) return stage;
            const weight = percentFrom(given.get(`${section.key}|${stage.key}`));
            if (weight === null) {
                throw productionTaskError('STAGE_WEIGHT_INVALID', 'Das Gewicht einer Stufe muss zwischen 0 und 100 liegen.', {
                    params: { section: section.name || section.key, name: stage.name || stage.key },
                });
            }
            return { ...stage, weight };
        }),
    }));
};

/**
 * Eine neue Stufe in einem Bereich der Kopie am Gerät (28.09.2026: «admins should be able to
 * add new stage if the section's weight is not 100%»). Nur solange die Aufgaben des Bereichs
 * zusammen unter 100 % wiegen — die neue Stufe nimmt den Rest auf. Name Pflicht und eindeutig;
 * in einem festen Bereich kommt sie vor die Fahne («final»), sonst ans Ende.
 */
export const withAddedStage = (
    sections: readonly ProductionTaskSection[],
    area: unknown,
    rawName: unknown,
): ProductionTaskSection[] => {
    const section = sections.find((entry) => entry.key === area);
    if (!section) throw productionTaskError('SECTION_INVALID', 'Bereich nicht gefunden.', { status: 404, params: { row: 0 } });
    const label = section.name || section.key;
    const name = text(rawName, PRODUCTION_TASK_LIMITS.stageName);
    if (!name) throw productionTaskError('STAGE_NAME_REQUIRED', 'Jede Stufe braucht einen Namen.', { params: { section: label } });
    if (section.stages.length >= PRODUCTION_TASK_LIMITS.stages) {
        throw productionTaskError('STAGES_TOO_MANY', `Höchstens ${PRODUCTION_TASK_LIMITS.stages} Stufen je Bereich.`, {
            params: { max: PRODUCTION_TASK_LIMITS.stages, section: label },
        });
    }
    if (section.stages.some((entry) => sameName(entry.name || entry.key, name))) {
        throw productionTaskError('STAGE_NAME_TAKEN', `Im Bereich «${label}» gibt es die Stufe «${name}» schon.`, {
            status: 409,
            params: { section: label, name },
        });
    }
    // Seit dem 30.09.2026 zählen die Gewichte der STUFEN: die neue nimmt, was im Bereich noch frei ist.
    const used = roundPercent(section.stages.reduce((sum, stage) => sum + stage.weight, 0));
    if (used >= 100 - SUM_TOLERANCE) {
        throw productionTaskError('SECTION_FULL', `Die Stufen von «${label}» wiegen schon 100 % — keine neue Stufe.`, {
            status: 409,
            params: { section: label },
        });
    }
    const stage: ProductionTaskSectionStage = { key: randomKey('g'), name, weight: roundPercent(100 - used) };
    const last = section.stages[section.stages.length - 1];
    const beforeFlag = isBuiltInArea(section.key) && last?.key === 'final';
    const stages = beforeFlag ? [...section.stages.slice(0, -1), stage, last] : [...section.stages, stage];
    return sections.map((entry) => (entry.key === section.key ? { ...entry, stages } : entry));
};

/** Ein älterer Browserstand schickt nur die Anteile von Mekanik und Elektrik. */
const legacySectionsFrom = (value: unknown): ProductionTaskSection[] => {
    const shares = objectOf(value);
    return builtInSections({}).map((section) => {
        const share = percentFrom(shares[section.key] ?? 0);
        if (share === null) {
            throw productionTaskError('SHARES_INVALID', 'Der Anteil eines Bereichs muss zwischen 0 und 100 liegen.', {
                params: { area: section.key },
            });
        }
        return { ...section, share };
    });
};

/**
 * Liest Name, Bereiche und Aufgaben einer Vorlage. Wirft bei allem, was sich
 * nicht speichern lässt (Name fehlt, Bereich ohne Namen, unbekannter Bereich,
 * Stufe passt nicht zum Bereich, Kürzel doppelt …). Summen, die nicht
 * aufgehen, sind KEIN Fehler — das sagt `templateCheck`.
 */
export const templateInputFrom = (body: unknown): ProductionTaskTemplateInput => {
    const input = objectOf(body);

    const name = text(input.name, PRODUCTION_TASK_LIMITS.templateName);
    if (!name) throw productionTaskError('NAME_REQUIRED', 'Die Vorlage braucht einen Namen.');

    // Seit dem 28.09.2026 kommen die Bereiche mit; ohne sie ist es ein älterer Browserstand.
    const sections = Array.isArray(input.sections) ? sectionsInputFrom(input.sections) : legacySectionsFrom(input.areaShares);

    // Die Kennungen der Aufgaben braucht nur das Gerät; eine Vorlage schreibt ihre Zeilen neu.
    const tasks = tasksInputFrom(input.tasks, sections, false).map(({ id: _id, ...task }) => task);
    // Ohne Gewichte der Stufen (älterer Browserstand) tragen die Aufgaben Anteile am Bereich.
    return requestHasStageWeights(input.sections) ? { name, sections, tasks } : { name, ...fromSectionShares(sections, tasks) };
};

/** Eine Aufgabe aus einer Anfrage — mit der Kennung, die sie mitbringt (null = neu). */
export type ProductionTaskInputRow = ProductionTaskDraft & { id: string | null };

/**
 * Die Aufgaben einer Anfrage in den Bereichen einer Vorlage bzw. eines Plans.
 * `withDates`: am Gerät tragen Aufgabe und Unteraufgaben Beginn und Termin
 * (und müssen zusammenpassen); in der Vorlage fallen sie weg. Aufgaben ohne
 * Kürzel bekommen das nächste freie ihres Bereichs.
 */
export const tasksInputFrom = (
    value: unknown,
    sections: readonly ProductionTaskSection[],
    withDates: boolean,
): ProductionTaskInputRow[] => {
    const rawTasks = Array.isArray(value) ? value : [];
    if (rawTasks.length > PRODUCTION_TASK_LIMITS.tasks) {
        throw productionTaskError('TASKS_TOO_MANY', `Höchstens ${PRODUCTION_TASK_LIMITS.tasks} Aufgaben.`, {
            params: { max: PRODUCTION_TASK_LIMITS.tasks },
        });
    }

    const tasks: ProductionTaskInputRow[] = [];
    rawTasks.forEach((raw, index) => {
        const row = objectOf(raw);
        const invalid = (field: string) => productionTaskError('TASK_INVALID', `Aufgabe ${index + 1}: «${field}» ist ungültig.`, {
            params: { row: index + 1, field },
            details: { index, field },
        });
        const section = sections.find((entry) => entry.key === row.area);
        if (!section) throw invalid('area');
        // Eine Stufe des anderen Wegs (alter Browserstand) wird umgelegt, Unbekanntes abgewiesen.
        const stage = stageOfSection(section, row.stage);
        if (!stage) throw invalid('stage');
        const code = text(row.code, PRODUCTION_TASK_LIMITS.code);
        const taskName = text(row.name, PRODUCTION_TASK_LIMITS.taskName);
        if (!taskName) throw invalid('name');
        const weight = percentFrom(row.weight);
        if (weight === null) throw invalid('weight');
        const subtasks = subtasksInputFrom(row.subtasks, withDates);
        if (!subtasks) throw invalid('subtasks');
        const startDate = withDates ? dayFrom(row.startDate) : null;
        if (startDate === undefined) throw invalid('startDate');
        const dueDate = withDates ? dayFrom(row.dueDate) : null;
        if (dueDate === undefined) throw invalid('dueDate');
        const datesProblem = taskDatesProblem({ startDate, dueDate }, subtasks);
        if (datesProblem) {
            throw productionTaskError('TASK_DATES_INVALID', `Aufgabe ${index + 1}: die Tage passen nicht zusammen.`, {
                params: { row: index + 1, field: datesProblem },
                details: { index, field: datesProblem },
            });
        }
        // Wiegt die Aufgabe 0, tragen ihre Unteraufgaben kein Gewicht (28.09.2026).
        if (weight === 0) for (const subtask of subtasks) subtask.weight = null;
        const subtaskSum = subtaskWeightSum(subtasks);
        if (subtaskSum > 100 + SUM_TOLERANCE) {
            throw productionTaskError('SUBTASK_WEIGHTS_INVALID', `Aufgabe ${index + 1}: die Unteraufgaben ergeben zusammen mehr als 100 % der Aufgabe.`, {
                params: { row: index + 1, sum: subtaskSum, max: 100 },
                details: { index, field: 'subtasks' },
            });
        }
        if (code && tasks.some((task) => task.code && sameTaskCode(task.code, code))) {
            throw productionTaskError('CODE_DUPLICATE', `Das Kürzel ${code} steht zweimal in der Vorlage.`, {
                status: 409,
                params: { code },
                details: { index, field: 'code' },
            });
        }
        const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : null;
        tasks.push({
            id,
            area: section.key,
            stage,
            code,
            name: taskName,
            weight,
            // Personen stehen nur an den Unteraufgaben (29.09.2026) — `row.assigneeIds` zählt nicht mehr.
            assigneeIds: taskAssigneesOf(subtasks),
            // Beginn und Termin gibt es erst am Gerät — eine Vorlage trägt keine (28.09.2026).
            startDate,
            dueDate,
            createdAt: createdDayFrom(row.createdAt),
            subtasks,
        });
    });
    fillMissingCodes(sections, tasks);
    return tasks;
};

/* ── Vollständig? ───────────────────────────────────────────────────────── */

/** Eine Stufe (30.09.2026): ihr Gewicht im Bereich und was ihre Aufgaben zusammen wiegen. */
export interface ProductionTaskStageCheck {
    stage: string;
    weight: number;
    taskCount: number;
    /** Die Gewichte ihrer Aufgaben zusammen (in der Stufe) — 100 %, wenn sie Aufgaben hat. */
    taskWeightSum: number;
    ok: boolean;
}

export interface ProductionTaskAreaCheck {
    area: string;
    share: number;
    taskCount: number;
    /** Die Gewichte der STUFEN zusammen (30.09.2026) — 100 %, wenn der Bereich Aufgaben hat. */
    weightSum: number;
    ok: boolean;
    stages: ProductionTaskStageCheck[];
}

export interface ProductionTaskTemplateCheck {
    valid: boolean;
    sharesSum: number;
    sharesOk: boolean;
    areas: ProductionTaskAreaCheck[];
}

/**
 * Gehen die Summen auf? (30.09.2026: je Stufe.) Die Anteile der Bereiche ergeben 100 %. Ein
 * Bereich ohne Aufgaben ist nur in Ordnung, wenn er keinen Anteil trägt; einer mit Aufgaben,
 * wenn seine Stufen zusammen 100 % wiegen und jede Stufe stimmt: mit Aufgaben ergeben diese
 * 100 % der Stufe, ohne Aufgaben wiegt sie 0.
 */
export const templateCheck = (
    sections: readonly ProductionTaskSection[],
    tasks: ReadonlyArray<Pick<ProductionTaskDraft, 'area' | 'stage' | 'weight'>>,
): ProductionTaskTemplateCheck => {
    const sharesSum = roundPercent(sections.reduce((sum, section) => sum + section.share, 0));
    const sharesOk = Math.abs(sharesSum - 100) <= SUM_TOLERANCE;
    const checks = sections.map((section): ProductionTaskAreaCheck => {
        const own = tasks.filter((task) => task.area === section.key);
        const stages = section.stages.map((stage): ProductionTaskStageCheck => {
            const inStage = own.filter((task) => task.stage === stage.key);
            const taskWeightSum = roundPercent(inStage.reduce((sum, task) => sum + task.weight, 0));
            const ok = inStage.length > 0 ? Math.abs(taskWeightSum - 100) <= SUM_TOLERANCE : stage.weight === 0;
            return { stage: stage.key, weight: stage.weight, taskCount: inStage.length, taskWeightSum, ok };
        });
        const weightSum = roundPercent(section.stages.reduce((sum, stage) => sum + stage.weight, 0));
        const ok = own.length > 0
            ? Math.abs(weightSum - 100) <= SUM_TOLERANCE && stages.every((stage) => stage.ok)
            : section.share === 0;
        return { area: section.key, share: section.share, taskCount: own.length, weightSum, ok, stages };
    });
    const hasTasks = checks.some((check) => check.taskCount > 0);
    return { valid: sharesOk && hasTasks && checks.every((check) => check.ok), sharesSum, sharesOk, areas: checks };
};

/**
 * Reihenfolge der Aufgaben: Bereich, Stufe des Weges, dann wie eingegeben.
 * So stehen sie in der Vorlage wie am Gerät in derselben Folge.
 */
export const orderTasks = <T extends Pick<ProductionTaskDraft, 'area' | 'stage'>>(
    tasks: readonly T[],
    sections: readonly ProductionTaskSection[],
): T[] => {
    const last = Number.MAX_SAFE_INTEGER;
    const areaRank = new Map(sections.map((section, index) => [section.key, index]));
    const stageRank = new Map(sections.map((section) => [section.key, new Map(section.stages.map((stage, index) => [stage.key, index]))]));
    return tasks
        .map((task, index) => ({ task, index }))
        .sort((left, right) => {
            const area = (areaRank.get(left.task.area) ?? last) - (areaRank.get(right.task.area) ?? last);
            if (area) return area;
            const stages = stageRank.get(left.task.area);
            const stage = (stages?.get(left.task.stage) ?? last) - (stages?.get(right.task.stage) ?? last);
            return stage || left.index - right.index;
        })
        .map((entry) => entry.task);
};

/* ── Wer ist neu dabei? ────────────────────────────────────────────────── */

type NewsTask = Pick<ProductionTaskDraft, 'area' | 'stage' | 'code' | 'name'>;

type NewsSubtask = Pick<ProductionSubtask, 'id' | 'name' | 'assigneeIds'>;

/**
 * Person → die Unteraufgaben, an denen sie NEU steht (29.09.2026: Personen
 * gibt es nur noch an Unteraufgaben). Verglichen wird je Unteraufgabe über
 * das Kürzel ihrer Aufgabe und ihre Kennung: wer beim Ersetzen einer Vorlage
 * an derselben Unteraufgabe bleibt, wird nicht noch einmal benachrichtigt.
 * Die Nachricht nennt das Kürzel der Unteraufgabe («M-01.2») und ihren Namen.
 */
export const assignmentNews = (
    before: ReadonlyArray<Pick<ProductionTaskDraft, 'code'> & { subtasks: ReadonlyArray<Pick<ProductionSubtask, 'id' | 'assigneeIds'>> }>,
    after: ReadonlyArray<NewsTask & { subtasks: ReadonlyArray<NewsSubtask> }>,
): Map<string, NewsTask[]> => {
    // Kürzel der Aufgabe → Kennung der Unteraufgabe → ihre Personen vorher.
    const previous = new Map(before.map((task) => [
        codeKey(task.code),
        new Map(task.subtasks.map((subtask) => [subtask.id, new Set(subtask.assigneeIds)])),
    ]));
    const news = new Map<string, NewsTask[]>();
    for (const task of after) {
        const earlier = previous.get(codeKey(task.code));
        task.subtasks.forEach((subtask, index) => {
            const had = earlier?.get(subtask.id);
            for (const id of subtask.assigneeIds) {
                if (had?.has(id)) continue;
                const list = news.get(id) ?? [];
                list.push({ area: task.area, stage: task.stage, code: `${task.code}.${index + 1}`, name: subtask.name });
                news.set(id, list);
            }
        });
    }
    return news;
};

/* ── Das Beispiel: Chiller ─────────────────────────────────────────────── */

/**
 * «Bunu siz bir şablon örneği olarak yapın, şablon adı Chiller … şablonda
 *  aşamaları da ekleyin.» — Samets Liste, jede Aufgabe auf die Stufe ihres
 * Weges gelegt (27.09.2026 auf die zwei Wege umgelegt: «chiller'i buraya
 * dağıt»):
 *
 *   Mekanik (60 %)   Compressor seçimi & PID  M-01 … M-04 (Einsatzbedingungen,
 *                                             Hauptkomponenten, Kälte- und
 *                                             Hydraulikkreis = das R&I/P&ID)
 *                    Teknik çizim             M-05 Gestell und Gehäuse
 *                    Final çizim onayı        —
 *                    BOM                      M-06
 *                    Üretim/Montaj            M-07 … M-11
 *                    Test                     M-12, M-13 (Dichtheit, Vakuum/Füllung)
 *                    Final                    M-14 Isolierung und Endkontrolle
 *   Elektrik (40 %)  Teknik devre çizimi      E-01 … E-05 (Lasten, Schutz,
 *                    (EPLAN)                  Schaltpläne, Schrankaufbau, Steuerung)
 *                    Final çizim onayı        —
 *                    BOM                      E-06
 *                    Pano imalatı             E-07 … E-11 (Schrank, Verdrahtung, Sensorik, PE)
 *                    Test                     E-12 … E-14 (Software, E/A, Prüfungen)
 *                    Final                    E-15 Son durum dokümanları ve yedekleme
 *
 * Personen stehen im Beispiel keine — die weist die Firma selbst zu. Es
 * bleibt bei den festen Bereichen Mekanik / Elektrik.
 */
export const CHILLER_EXAMPLE_KEY = 'chiller';

type ExampleTask = [code: string, name: string, stage: ProductionBuiltInStage, weight: number];

const CHILLER_MECHANICAL: ExampleTask[] = [
    ['M-01', 'Çalışma şartlarını belirleme', 'equipment', 5],
    ['M-02', 'Ana ekipman seçimi', 'equipment', 9],
    ['M-03', 'Soğutma devresi tasarımı', 'equipment', 8],
    ['M-04', 'Hidrolik devre tasarımı', 'equipment', 6],
    ['M-05', 'Şase ve gövde tasarımı', 'drawing', 7],
    ['M-06', 'Teknik dokümantasyon ve mekanik BOM', 'bom', 5],
    ['M-07', 'Şase ve sac imalatı', 'production', 10],
    ['M-08', 'Ana ekipman montajı', 'production', 8],
    ['M-09', 'Soğutucu akışkan borulaması', 'production', 14],
    ['M-10', 'Hidrolik grup montajı', 'production', 8],
    ['M-11', 'Fan grubu montajı', 'production', 4],
    ['M-12', 'Basınç ve sızdırmazlık kontrolleri', 'test', 6],
    ['M-13', 'Vakum ve akışkan şarjı', 'test', 6],
    ['M-14', 'İzolasyon ve son mekanik kontrol', 'final', 4],
];

const CHILLER_ELECTRICAL: ExampleTask[] = [
    ['E-01', 'Elektrik yüklerini belirleme', 'circuit', 4],
    ['E-02', 'Güç ve koruma tasarımı', 'circuit', 8],
    ['E-03', 'Elektrik şemaları', 'circuit', 10],
    ['E-04', 'Pano yerleşimi', 'circuit', 5],
    ['E-05', 'Kontrol mimarisi', 'circuit', 8],
    ['E-06', 'Elektrik BOM ve dokümanları', 'bom', 5],
    ['E-07', 'Pano montajı', 'panel', 8],
    ['E-08', 'Pano içi kablolama', 'panel', 10],
    ['E-09', 'Cihaz içi kablolama', 'panel', 10],
    ['E-10', 'Sensör ve kumanda bağlantıları', 'panel', 6],
    ['E-11', 'Koruyucu iletken bağlantıları', 'panel', 4],
    ['E-12', 'Yazılım ve parametre yükleme', 'test', 10],
    ['E-13', 'Giriş-çıkış doğrulama', 'test', 5],
    ['E-14', 'Elektriksel testler', 'test', 5],
    ['E-15', 'Son durum dokümanları ve yedekleme', 'final', 2],
];

// Die Liste nennt Anteile am Bereich — `fromSectionShares` macht daraus Stufen- und Aufgabengewichte.
export const CHILLER_EXAMPLE: ProductionTaskTemplateInput = {
    name: 'Chiller',
    ...fromSectionShares(builtInSections({ MECHANICAL: 60, ELECTRICAL: 40 }), [
        ...CHILLER_MECHANICAL.map(([code, name, stage, weight]): ProductionTaskDraft => ({
            area: 'MECHANICAL', stage, code, name, weight, assigneeIds: [], startDate: null, dueDate: null, createdAt: null, subtasks: [],
        })),
        ...CHILLER_ELECTRICAL.map(([code, name, stage, weight]): ProductionTaskDraft => ({
            area: 'ELECTRICAL', stage, code, name, weight, assigneeIds: [], startDate: null, dueDate: null, createdAt: null, subtasks: [],
        })),
    ]),
};
