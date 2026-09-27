import type {
    ProductionAreaShares,
    ProductionTaskArea,
    ProductionTaskDraft,
    ProductionTaskStage,
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
 */

export const PRODUCTION_TASK_AREAS: readonly ProductionTaskArea[] = ['MECHANICAL', 'ELECTRICAL'];

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
 */
export const PRODUCTION_TASK_STAGES: Readonly<Record<ProductionTaskArea, readonly ProductionTaskStage[]>> = {
    MECHANICAL: ['equipment', 'drawing', 'approval', 'bom', 'production', 'test', 'final'],
    ELECTRICAL: ['circuit', 'approval', 'bom', 'panel', 'test', 'final'],
};

/**
 * Wohin eine Stufe gehört, die es im Bereich (nicht mehr) gibt — für
 * Aufgaben aus der Zeit vor den zwei Wegen und für einen Browser mit altem
 * Stand: die Zeichnung der Mekanik wird in der Elektrik zum EPLAN-Stromlauf,
 * die Montage zum Schaltschrankbau, der Einkauf fällt auf die Stückliste.
 */
const STAGE_TWINS: Readonly<Record<string, Partial<Record<ProductionTaskArea, ProductionTaskStage>>>> = {
    equipment: { ELECTRICAL: 'circuit' },
    circuit: { MECHANICAL: 'equipment' },
    drawing: { ELECTRICAL: 'circuit' },
    production: { ELECTRICAL: 'panel' },
    panel: { MECHANICAL: 'production' },
    purchasing: { MECHANICAL: 'bom', ELECTRICAL: 'bom' },
};

/** Die gültige Stufe eines Bereichs zu einer gespeicherten/gesendeten; unbekannt → null. */
export const stageOfArea = (area: ProductionTaskArea, value: unknown): ProductionTaskStage | null => {
    if (typeof value !== 'string') return null;
    if ((PRODUCTION_TASK_STAGES[area] as readonly string[]).includes(value)) return value as ProductionTaskStage;
    return STAGE_TWINS[value]?.[area] ?? null;
};

export const PRODUCTION_TASK_LIMITS = {
    templateName: 120,
    code: 16,
    taskName: 200,
    tasks: 200,
    assignees: 20,
} as const;

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
    | 'TASKS_TOO_MANY'
    | 'TASK_INVALID'
    | 'CODE_DUPLICATE'
    | 'DEVICE_NOT_FOUND'
    | 'PLAN_EXISTS'
    | 'PLAN_NOT_FOUND'
    | 'TASK_NOT_FOUND';

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

const percentFrom = (value: unknown): number | null => {
    const number = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
    if (typeof value === 'boolean' || value === null || value === undefined || value === '') return null;
    if (!Number.isFinite(number) || number < 0 || number > 100) return null;
    return roundPercent(number);
};

export const isProductionTaskArea = (value: unknown): value is ProductionTaskArea =>
    typeof value === 'string' && (PRODUCTION_TASK_AREAS as readonly string[]).includes(value);


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

/** Anteile aus der Datenbank oder einer Anfrage — Unbekanntes wird 0. */
export const areaSharesFrom = (value: unknown): ProductionAreaShares => {
    const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    return {
        MECHANICAL: percentFrom(source.MECHANICAL) ?? 0,
        ELECTRICAL: percentFrom(source.ELECTRICAL) ?? 0,
    };
};

/** Vergleich von Kürzeln: ohne Gross/klein, ohne Leerraum. */
const codeKey = (code: string): string => code.replace(/\s+/g, '').toLocaleUpperCase('tr-TR');

export const sameTaskCode = (left: string, right: string): boolean => codeKey(left) === codeKey(right);

/* ── Eine Vorlage aus der Anfrage ──────────────────────────────────────── */

/**
 * Liest Name, Anteile und Aufgaben einer Vorlage. Wirft bei allem, was sich
 * nicht speichern lässt (Name fehlt, unbekannter Bereich, Stufe passt nicht
 * zum Bereich, Kürzel doppelt …). Summen, die nicht aufgehen, sind KEIN
 * Fehler — das sagt `templateCheck`.
 */
export const templateInputFrom = (body: unknown): ProductionTaskTemplateInput => {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

    const name = text(input.name, PRODUCTION_TASK_LIMITS.templateName);
    if (!name) throw productionTaskError('NAME_REQUIRED', 'Die Vorlage braucht einen Namen.');

    const rawShares = (input.areaShares && typeof input.areaShares === 'object' ? input.areaShares : {}) as Record<string, unknown>;
    const areaShares = {} as ProductionAreaShares;
    for (const area of PRODUCTION_TASK_AREAS) {
        const share = percentFrom(rawShares[area] ?? 0);
        if (share === null) {
            throw productionTaskError('SHARES_INVALID', 'Der Anteil eines Bereichs muss zwischen 0 und 100 liegen.', {
                params: { area },
            });
        }
        areaShares[area] = share;
    }

    const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
    if (rawTasks.length > PRODUCTION_TASK_LIMITS.tasks) {
        throw productionTaskError('TASKS_TOO_MANY', `Höchstens ${PRODUCTION_TASK_LIMITS.tasks} Aufgaben je Vorlage.`, {
            params: { max: PRODUCTION_TASK_LIMITS.tasks },
        });
    }

    const tasks: ProductionTaskDraft[] = [];
    rawTasks.forEach((raw, index) => {
        const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const invalid = (field: string) => productionTaskError('TASK_INVALID', `Aufgabe ${index + 1}: «${field}» ist ungültig.`, {
            params: { row: index + 1, field },
            details: { index, field },
        });
        if (!isProductionTaskArea(row.area)) throw invalid('area');
        const area = row.area;
        // Eine Stufe des anderen Wegs (alter Browserstand) wird umgelegt, Unbekanntes abgewiesen.
        const stage = stageOfArea(area, row.stage);
        if (!stage) throw invalid('stage');
        const code = text(row.code, PRODUCTION_TASK_LIMITS.code);
        if (!code) throw invalid('code');
        const taskName = text(row.name, PRODUCTION_TASK_LIMITS.taskName);
        if (!taskName) throw invalid('name');
        const weight = percentFrom(row.weight);
        if (weight === null) throw invalid('weight');
        if (tasks.some((task) => sameTaskCode(task.code, code))) {
            throw productionTaskError('CODE_DUPLICATE', `Das Kürzel ${code} steht zweimal in der Vorlage.`, {
                status: 409,
                params: { code },
                details: { index, field: 'code' },
            });
        }
        tasks.push({ area, stage, code, name: taskName, weight, assigneeIds: assigneeIdsFrom(row.assigneeIds) });
    });

    return { name, areaShares, tasks };
};

/* ── Vollständig? ───────────────────────────────────────────────────────── */

export interface ProductionTaskAreaCheck {
    area: ProductionTaskArea;
    share: number;
    taskCount: number;
    weightSum: number;
    ok: boolean;
}

export interface ProductionTaskTemplateCheck {
    valid: boolean;
    sharesSum: number;
    sharesOk: boolean;
    areas: ProductionTaskAreaCheck[];
}

/**
 * Gehen die Summen auf? Ein Bereich ohne Aufgaben ist nur in Ordnung, wenn er
 * auch keinen Anteil trägt; einer mit Aufgaben, wenn deren Gewichte 100 %
 * ergeben.
 */
export const templateCheck = (
    areaShares: ProductionAreaShares,
    areas: Record<ProductionTaskArea, { taskCount: number; weightSum: number }>,
): ProductionTaskTemplateCheck => {
    const sharesSum = roundPercent(PRODUCTION_TASK_AREAS.reduce((sum, area) => sum + (areaShares[area] ?? 0), 0));
    const sharesOk = Math.abs(sharesSum - 100) <= SUM_TOLERANCE;
    const checks = PRODUCTION_TASK_AREAS.map((area): ProductionTaskAreaCheck => {
        const share = areaShares[area] ?? 0;
        const taskCount = areas[area]?.taskCount ?? 0;
        const weightSum = roundPercent(areas[area]?.weightSum ?? 0);
        const ok = taskCount > 0 ? Math.abs(weightSum - 100) <= SUM_TOLERANCE : share === 0;
        return { area, share, taskCount, weightSum, ok };
    });
    const hasTasks = checks.some((check) => check.taskCount > 0);
    return { valid: sharesOk && hasTasks && checks.every((check) => check.ok), sharesSum, sharesOk, areas: checks };
};

/** Aufgaben und Gewichtssumme je Bereich — aus einer Aufgabenliste gezählt. */
export const areaTotals = (tasks: ReadonlyArray<Pick<ProductionTaskDraft, 'area' | 'weight'>>) => {
    const totals = {} as Record<ProductionTaskArea, { taskCount: number; weightSum: number }>;
    for (const area of PRODUCTION_TASK_AREAS) totals[area] = { taskCount: 0, weightSum: 0 };
    for (const task of tasks) {
        const entry = totals[task.area];
        if (!entry) continue;
        entry.taskCount += 1;
        entry.weightSum = roundPercent(entry.weightSum + task.weight);
    }
    return totals;
};

/**
 * Reihenfolge der Aufgaben: Bereich, Stufe des Weges, dann wie eingegeben.
 * So stehen sie in der Vorlage wie am Gerät in derselben Folge.
 */
export const orderTasks = <T extends Pick<ProductionTaskDraft, 'area' | 'stage'>>(tasks: readonly T[]): T[] =>
    tasks
        .map((task, index) => ({ task, index }))
        .sort((left, right) => {
            const area = PRODUCTION_TASK_AREAS.indexOf(left.task.area) - PRODUCTION_TASK_AREAS.indexOf(right.task.area);
            if (area) return area;
            const stages = PRODUCTION_TASK_STAGES[left.task.area];
            const stage = stages.indexOf(left.task.stage) - stages.indexOf(right.task.stage);
            return stage || left.index - right.index;
        })
        .map((entry) => entry.task);

/* ── Wer ist neu dabei? ────────────────────────────────────────────────── */

type NewsTask = Pick<ProductionTaskDraft, 'area' | 'stage' | 'code' | 'name'>;

/**
 * Person → die Aufgaben, in denen sie NEU steht. Verglichen wird je Aufgabe
 * über ihr Kürzel: wer beim Ersetzen einer Vorlage in derselben Aufgabe
 * bleibt, wird nicht noch einmal benachrichtigt.
 */
export const assignmentNews = (
    before: ReadonlyArray<Pick<ProductionTaskDraft, 'code' | 'assigneeIds'>>,
    after: ReadonlyArray<NewsTask & Pick<ProductionTaskDraft, 'assigneeIds'>>,
): Map<string, NewsTask[]> => {
    const previous = new Map(before.map((task) => [codeKey(task.code), new Set(task.assigneeIds)]));
    const news = new Map<string, NewsTask[]>();
    for (const task of after) {
        const had = previous.get(codeKey(task.code));
        for (const id of task.assigneeIds) {
            if (had?.has(id)) continue;
            const list = news.get(id) ?? [];
            list.push({ area: task.area, stage: task.stage, code: task.code, name: task.name });
            news.set(id, list);
        }
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
 * Personen stehen im Beispiel keine — die weist die Firma selbst zu.
 */
export const CHILLER_EXAMPLE_KEY = 'chiller';

type ExampleTask = [code: string, name: string, stage: ProductionTaskStage, weight: number];

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

export const CHILLER_EXAMPLE: ProductionTaskTemplateInput = {
    name: 'Chiller',
    areaShares: { MECHANICAL: 60, ELECTRICAL: 40 },
    tasks: [
        ...CHILLER_MECHANICAL.map(([code, name, stage, weight]): ProductionTaskDraft => ({
            area: 'MECHANICAL', stage, code, name, weight, assigneeIds: [],
        })),
        ...CHILLER_ELECTRICAL.map(([code, name, stage, weight]): ProductionTaskDraft => ({
            area: 'ELECTRICAL', stage, code, name, weight, assigneeIds: [],
        })),
    ],
};
