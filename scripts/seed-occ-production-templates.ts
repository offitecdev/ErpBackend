/**
 * ── OCC-STANDARD ALS GÖREV-VORLAGEN (02.10.2026, Vorgabe Samet) ─────────────
 *
 * Schreibt den OCC «Üretim, Test ve Sevkiyat Kontrol Standardı» als DATEN in die Vorlagen einer
 * Firma: Chiller (vorhanden — nur Unteraufgaben kommen dazu), Dry Cooler und Isı Pompası (neu,
 * falls es sie nicht gibt). Die Daten stehen in `occ-production-standard.data.ts`.
 *
 *   npx ts-node scripts/seed-occ-production-templates.ts                    Firmen und ihre Vorlagen auflisten
 *   npx ts-node scripts/seed-occ-production-templates.ts <tenantId> --dry   Vorschau, schreibt nichts
 *   npx ts-node scripts/seed-occ-production-templates.ts <tenantId>         schreiben (vorher Sicherung)
 *   Optionen: --actor <employeeId>  (wer als «geändert von» steht; sonst leer wie beim Beispiel)
 *             --allow-drop          (auch dann schreiben, wenn inaktive Personen wegfallen würden)
 *
 * Regeln: geschrieben wird über den Anwendungsfall der Vorlagen (Normalisierung + Prüfung), nie
 * mit rohem SQL. Vorlage nach NAME, Aufgabe nach KÜRZEL (und Name), Unteraufgabe nach NAME — ein
 * zweiter Lauf legt nichts doppelt an: vorhandene Unteraufgaben bekommen nur Checkliste, Standards
 * und Flags; Aufgaben, Gewichte, Personen und Tage bleiben. Eine Aufgabe ohne Unteraufgaben teilt
 * ihr Gewicht gleich auf die neuen auf, sonst tragen die neuen keins. Geräte bleiben unberührt.
 * Vor dem Schreiben gehen die alten Unteraufgaben (roh) nach scripts/backups/.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import prisma from '../src/infrastructure/database/prisma.client';
import {
    PrismaProductionTaskDirectory,
    PrismaProductionTaskTemplateRepository,
} from '../src/infrastructure/repositories/ProductionTaskRepository';
import { ProductionTaskTemplatesUseCase, type ProductionTaskActor } from '../src/application/use-cases/production/ProductionTaskTemplatesUseCase';
import {
    assigneesOf,
    type ProductionSubtaskDto,
    type ProductionTaskDto,
    type ProductionTaskTemplateDto,
} from '../src/application/use-cases/production/productionTaskReadModel';
import {
    BUILT_IN_AREAS,
    BUILT_IN_STAGES,
    PRODUCTION_TASK_LIMITS,
    roundPercent,
    sameTaskCode,
    templateCheck,
    templateInputFrom,
} from '../src/domain/services/productionTasks';
import { OCC_SEED_TEMPLATES, type OccSeedSubtask, type OccSeedTask, type OccSeedTemplate } from './occ-production-standard.data';

/* ── Aufruf ─────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ALLOW_DROP = args.includes('--allow-drop');
const optionValue = (name: string): string | null => {
    const at = args.indexOf(name);
    const value = at >= 0 ? args[at + 1] : undefined;
    return value && !value.startsWith('--') ? value : null;
};
const ACTOR_ID = optionValue('--actor');
const TENANT_ID = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--actor') ?? null;

/* ── Wie der Server normalisiert (productionTasks.ts: text / multilineText) ── */

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();
const multiline = (value: string): string => value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const nameKey = (value: string): string => oneLine(value).toLocaleLowerCase('tr-TR').replace(/ı/g, 'i');
const sameName = (left: string, right: string): boolean => nameKey(left) === nameKey(right);

/* ── Die gewünschte Unteraufgabe ────────────────────────────────────────── */

interface SubtaskBody {
    id?: string;
    name: string;
    weight: number | null;
    createdAt?: string | null;
    startDate: null;
    dueDate: null;
    assigneeIds: string[];
    requiresDocument: boolean;
    requiresApproval: boolean;
    photoAllowed: boolean;
    feeRequired: boolean;
    priorStepsRequired: boolean;
    approvalChecklist: Array<{ id?: string; text: string }>;
    documentStandards: string | null;
    documentStandardsFile: unknown;
}

interface Wanted {
    requiresDocument: boolean;
    requiresApproval: boolean;
    photoAllowed: boolean;
    feeRequired: boolean;
    priorStepsRequired: boolean;
    checklist: string[];
    standards: string | null;
}

const wantedOf = (seed: OccSeedSubtask): Wanted => {
    const requiresDocument = seed.flags.includes('D');
    const requiresApproval = seed.flags.includes('O');
    return {
        requiresDocument,
        requiresApproval,
        photoAllowed: requiresDocument && seed.flags.includes('F'),
        // U = Ücret girilsin, K = Kilit (02.10.2026 abends).
        feeRequired: seed.flags.includes('U'),
        priorStepsRequired: seed.flags.includes('K'),
        checklist: requiresApproval ? seed.checklist.map(oneLine).filter(Boolean) : [],
        standards: requiresDocument && seed.standards ? multiline(seed.standards) : null,
    };
};

/** Die Grenzen des Servers — lieber hier laut scheitern als still kürzen. */
const assertLimits = (where: string, seed: OccSeedSubtask, wanted: Wanted): void => {
    if (oneLine(seed.name).length > PRODUCTION_TASK_LIMITS.subtaskName) throw new Error(`${where}: Name zu lang`);
    if (wanted.checklist.length > PRODUCTION_TASK_LIMITS.checklistItems) throw new Error(`${where}: zu viele Punkte (${wanted.checklist.length})`);
    const long = wanted.checklist.find((item) => item.length > PRODUCTION_TASK_LIMITS.checklistItemText);
    if (long) throw new Error(`${where}: Punkt zu lang: ${long}`);
    if ((wanted.standards ?? '').length > PRODUCTION_TASK_LIMITS.documentStandards) throw new Error(`${where}: Standards zu lang (${wanted.standards?.length})`);
};

/** Eine vorhandene Unteraufgabe als Teil der Anfrage — alles, was sie trägt, bleibt. */
const bodyOfExisting = (subtask: ProductionSubtaskDto): SubtaskBody => ({
    id: subtask.id,
    name: subtask.name,
    weight: subtask.weight,
    createdAt: subtask.createdAt,
    startDate: null,
    dueDate: null,
    assigneeIds: [...subtask.assigneeIds],
    requiresDocument: subtask.requiresDocument,
    requiresApproval: subtask.requiresApproval,
    photoAllowed: subtask.photoAllowed === true,
    feeRequired: subtask.feeRequired === true,
    priorStepsRequired: subtask.priorStepsRequired === true,
    approvalChecklist: subtask.approvalChecklist.map((item) => ({ id: item.id, text: item.text })),
    documentStandards: subtask.documentStandards,
    documentStandardsFile: subtask.documentStandardsFile,
});

/** Was sich an einer vorhandenen Unteraufgabe ändern würde — leer: nichts. */
const differences = (subtask: ProductionSubtaskDto, wanted: Wanted): string[] => {
    const changes: string[] = [];
    if (subtask.requiresDocument !== wanted.requiresDocument) changes.push('Doküman');
    if (subtask.requiresApproval !== wanted.requiresApproval) changes.push('Onay');
    if ((subtask.photoAllowed === true) !== wanted.photoAllowed) changes.push('Fotoğraf yeterli');
    if ((subtask.feeRequired === true) !== wanted.feeRequired) changes.push('Ücret');
    if ((subtask.priorStepsRequired === true) !== wanted.priorStepsRequired) changes.push('Kilit');
    if (JSON.stringify(subtask.approvalChecklist.map((item) => item.text)) !== JSON.stringify(wanted.checklist)) changes.push('kontrol listesi');
    if ((subtask.documentStandards ?? null) !== wanted.standards) changes.push('standart');
    return changes;
};

/** Gleiche Anteile, zusammen genau 100 % (der Rest an die letzte). */
const equalWeights = (count: number): number[] => {
    if (!count) return [];
    const base = Math.floor(10000 / count) / 100;
    return Array.from({ length: count }, (_, index) => (index === count - 1 ? roundPercent(100 - base * (count - 1)) : base));
};

/* ── Der Plan einer Vorlage ─────────────────────────────────────────────── */

interface TemplatePlan {
    seed: OccSeedTemplate;
    existing: ProductionTaskTemplateDto | null;
    mode: 'create' | 'update' | 'missing';
    body: Record<string, unknown> | null;
    lines: string[];
    changes: number;
}

const flagText = (wanted: Wanted): string =>
    [
        wanted.requiresDocument ? 'D' : '',
        wanted.requiresApproval ? 'O' : '',
        wanted.photoAllowed ? 'F' : '',
        wanted.feeRequired ? 'U' : '',
        wanted.priorStepsRequired ? 'K' : '',
    ].join('') || '—';

const describe = (wanted: Wanted): string =>
    `${flagText(wanted)} · ${wanted.checklist.length} madde · standart ${wanted.standards?.length ?? 0} karakter`;

/** Die neuen Unteraufgaben einer Aufgabe (Gewichte: gleich, wenn sie vorher keine hatte; sonst ohne). */
const newSubtasks = (seeds: OccSeedSubtask[], hadSubtasks: boolean, taskWeight: number, where: string): SubtaskBody[] => {
    const weights = equalWeights(seeds.length);
    return seeds.map((seed, index) => {
        const wanted = wantedOf(seed);
        assertLimits(`${where} «${seed.name}»`, seed, wanted);
        return {
            name: oneLine(seed.name),
            weight: hadSubtasks || taskWeight === 0 ? null : weights[index] ?? null,
            startDate: null,
            dueDate: null,
            assigneeIds: [],
            requiresDocument: wanted.requiresDocument,
            requiresApproval: wanted.requiresApproval,
            photoAllowed: wanted.photoAllowed,
            feeRequired: wanted.feeRequired,
            priorStepsRequired: wanted.priorStepsRequired,
            approvalChecklist: wanted.checklist.map((text) => ({ text })),
            documentStandards: wanted.standards,
            documentStandardsFile: null,
        };
    });
};

/** Eine NEUE Vorlage: feste Bereiche Mekanik 60 / Elektrik 40, Stufen in ihrer festen Reihenfolge. */
const planCreate = (seed: OccSeedTemplate): TemplatePlan => {
    const lines: string[] = [`  + Vorlage «${seed.name}» wird angelegt (Mekanik %60 / Elektrik %40)`];
    const sections = BUILT_IN_AREAS.map((area) => ({
        key: area,
        name: '',
        share: area === 'MECHANICAL' ? 60 : 40,
        stages: BUILT_IN_STAGES[area].map((key) => ({ key, name: '', weight: seed.stageWeights[area][key] ?? 0 })),
    }));
    let changes = 1;
    const tasks = seed.tasks.map((task: OccSeedTask) => {
        const subtasks = newSubtasks(task.subtasks, false, task.weight, task.code);
        for (const [index, seedSub] of task.subtasks.entries()) {
            lines.push(`      + ${task.code}.${index + 1} «${seedSub.name}» ${describe(wantedOf(seedSub))} · ağırlık ${subtasks[index]?.weight ?? '—'}`);
            changes += 1;
        }
        return {
            area: task.area,
            stage: task.stage,
            code: task.code,
            name: task.name,
            weight: task.weight,
            assigneeIds: [],
            startDate: null,
            dueDate: null,
            subtasks,
        };
    });
    lines.splice(1, 0, `    ${tasks.length} görev`);
    return { seed, existing: null, mode: 'create', body: { name: seed.name, sections, tasks }, lines, changes };
};

/** Eine VORHANDENE Vorlage: nur Unteraufgaben — neu oder Checkliste/Standards/Flags. */
const planUpdate = (seed: OccSeedTemplate, existing: ProductionTaskTemplateDto): TemplatePlan => {
    const lines: string[] = [`  ~ Vorlage «${existing.name}» (${existing.id}) — nur alt görevler`];
    let changes = 0;
    const touched = new Map<string, SubtaskBody[]>();
    for (const seedTask of seed.tasks) {
        const task = existing.tasks.find((entry) => sameTaskCode(entry.code, seedTask.code));
        if (!task) {
            lines.push(`    ! ${seedTask.code} «${seedTask.name}»: Kürzel fehlt in der Vorlage — atlandı`);
            continue;
        }
        if (!sameName(task.name, seedTask.name)) {
            lines.push(`    ! ${seedTask.code}: Name «${task.name}» ≠ «${seedTask.name}» — atlandı`);
            continue;
        }
        if (!seedTask.subtasks.length) continue;
        const merged = task.subtasks.map(bodyOfExisting);
        const fresh: OccSeedSubtask[] = [];
        for (const seedSub of seedTask.subtasks) {
            const wanted = wantedOf(seedSub);
            assertLimits(`${seedTask.code} «${seedSub.name}»`, seedSub, wanted);
            const found = task.subtasks.find((entry) => sameName(entry.name, seedSub.name));
            if (!found) { fresh.push(seedSub); continue; }
            const index = task.subtasks.indexOf(found);
            const diff = differences(found, wanted);
            if (!diff.length) {
                lines.push(`      = ${task.code}.${index + 1} «${found.name}» aynı`);
                continue;
            }
            const target = merged[index];
            if (!target) continue;
            merged[index] = {
                ...target,
                requiresDocument: wanted.requiresDocument,
                requiresApproval: wanted.requiresApproval,
                photoAllowed: wanted.photoAllowed,
                feeRequired: wanted.feeRequired,
                priorStepsRequired: wanted.priorStepsRequired,
                // Gleicher Text behält seine Kennung.
                approvalChecklist: wanted.checklist.map((text) => {
                    const same = found.approvalChecklist.find((item) => item.text === text);
                    return same ? { id: same.id, text } : { text };
                }),
                documentStandards: wanted.standards,
                documentStandardsFile: wanted.requiresDocument ? target.documentStandardsFile : null,
            };
            lines.push(`      ~ ${task.code}.${index + 1} «${found.name}» güncellenir: ${diff.join(', ')} → ${describe(wanted)}`);
            changes += 1;
        }
        if (fresh.length) {
            const added = newSubtasks(fresh, task.subtasks.length > 0, task.weight, task.code);
            added.forEach((entry, offset) => {
                lines.push(`      + ${task.code}.${task.subtasks.length + offset + 1} «${entry.name}» ${describe(wantedOf(fresh[offset]!))} · ağırlık ${entry.weight ?? '—'}`);
            });
            merged.push(...added);
            changes += added.length;
        }
        if (merged.length > PRODUCTION_TASK_LIMITS.subtasks) throw new Error(`${task.code}: mehr als ${PRODUCTION_TASK_LIMITS.subtasks} Unteraufgaben`);
        touched.set(task.id, merged);
    }
    const body = {
        name: existing.name,
        sections: existing.sections,
        tasks: existing.tasks.map((task: ProductionTaskDto) => ({
            area: task.area,
            stage: task.stage,
            code: task.code,
            name: task.name,
            weight: task.weight,
            assigneeIds: [],
            startDate: null,
            dueDate: null,
            createdAt: task.createdAt,
            subtasks: touched.get(task.id) ?? task.subtasks.map(bodyOfExisting),
        })),
    };
    return { seed, existing, mode: 'update', body, lines, changes };
};

/** Bleiben Aufgaben, Gewichte und Personen der vorhandenen Vorlage gleich? (Nur Unteraufgaben kommen dazu.) */
const sameExceptSubtasks = (before: ProductionTaskTemplateDto, after: ProductionTaskTemplateDto): string[] => {
    const problems: string[] = [];
    if (before.tasks.length !== after.tasks.length) problems.push(`Aufgaben ${before.tasks.length} → ${after.tasks.length}`);
    for (const task of before.tasks) {
        const now = after.tasks.find((entry) => sameTaskCode(entry.code, task.code));
        if (!now) { problems.push(`${task.code} fehlt`); continue; }
        if (now.name !== task.name) problems.push(`${task.code} Name`);
        if (Math.abs(now.weight - task.weight) > 0.01) problems.push(`${task.code} Gewicht ${task.weight} → ${now.weight}`);
        if (now.area !== task.area || now.stage !== task.stage) problems.push(`${task.code} Stufe`);
        const people = new Set(now.assigneeIds);
        if (task.assigneeIds.some((id) => !people.has(id))) problems.push(`${task.code} Personen`);
        for (const subtask of task.subtasks) {
            const kept = now.subtasks.find((entry) => entry.id === subtask.id);
            if (!kept) { problems.push(`${task.code} «${subtask.name}» fehlt`); continue; }
            if (kept.weight !== subtask.weight || JSON.stringify(kept.assigneeIds) !== JSON.stringify(subtask.assigneeIds)) {
                problems.push(`${task.code} «${subtask.name}» Gewicht/Personen`);
            }
        }
    }
    for (const section of before.sections) {
        const now = after.sections.find((entry) => entry.key === section.key);
        if (!now || Math.abs(now.share - section.share) > 0.01) problems.push(`Bereich ${section.key}`);
        for (const stage of section.stages) {
            const nowStage = now?.stages.find((entry) => entry.key === stage.key);
            if (!nowStage || Math.abs(nowStage.weight - stage.weight) > 0.01) problems.push(`Stufe ${section.key}/${stage.key}`);
        }
    }
    return problems;
};

/* ── Ablauf ─────────────────────────────────────────────────────────────── */

const listFirms = async (): Promise<void> => {
    const [tenants, templates] = await Promise.all([
        prisma.tenant.findMany({ where: { isActive: true }, select: { id: true, tenantName: true, companyType: true, parentTenantId: true }, orderBy: { tenantName: 'asc' } }),
        prisma.productionTaskTemplate.findMany({ where: { deletedAt: null }, select: { tenantId: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    console.log('Firmen (aktiv) und ihre Görev-Vorlagen:');
    for (const tenant of tenants) {
        const own = templates.filter((row) => row.tenantId === tenant.id).map((row) => row.name);
        const type = tenant.companyType ? ` [${tenant.companyType}]` : '';
        console.log(`  ${tenant.id}  ${tenant.tenantName}${type}${tenant.parentTenantId ? ' (alt şirket)' : ''}`);
        console.log(`      ${own.length ? own.join(' · ') : '— keine Vorlagen —'}`);
    }
};

const main = async (): Promise<void> => {
    await listFirms();
    if (!TENANT_ID) {
        console.log('\nKeine Firma angegeben — nichts geschrieben. Aufruf: npx ts-node scripts/seed-occ-production-templates.ts <tenantId> [--dry]');
        return;
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: TENANT_ID }, select: { id: true, tenantName: true } });
    if (!tenant) throw new Error(`Firma ${TENANT_ID} gibt es nicht.`);
    console.log(`\nFirma: ${tenant.tenantName} (${tenant.id})${DRY ? ' — VORSCHAU (--dry), es wird nichts geschrieben' : ''}\n`);

    const repository = new PrismaProductionTaskTemplateRepository();
    const directory = new PrismaProductionTaskDirectory();
    const useCase = new ProductionTaskTemplatesUseCase(repository, directory);
    // Ohne --actor steht niemand als «geändert von» — wie beim Beispiel «Chiller», das der Server selbst anlegte.
    const actor: ProductionTaskActor = { id: ACTOR_ID ?? (null as unknown as string), name: 'OCC seed' };

    // Lesen über das Lager — `useCase.list` legte bei einer Firma ohne Vorlagen das Beispiel an.
    const summaries = await repository.list(tenant.id);
    const plans: TemplatePlan[] = [];
    for (const seed of OCC_SEED_TEMPLATES) {
        const found = summaries.find((row) => sameName(row.name, seed.name));
        if (found) {
            plans.push(planUpdate(seed, await useCase.get(tenant.id, found.id)));
        } else if (seed.create) {
            plans.push(planCreate(seed));
        } else {
            plans.push({ seed, existing: null, mode: 'missing', body: null, lines: [`  ! Vorlage «${seed.name}» gibt es in dieser Firma nicht — wird NICHT angelegt (atlandı)`], changes: 0 });
        }
    }

    // Prüfen wie der Server: normalisieren, Summen, Personen.
    let blocked = false;
    for (const plan of plans) {
        console.log(plan.lines.join('\n'));
        if (!plan.body) { console.log(''); continue; }
        const input = templateInputFrom(plan.body);
        const check = templateCheck(input.sections, input.tasks);
        console.log(`    Summen: ${check.valid ? 'Hazır ✓' : 'EKSİK ✗'} (Bereiche ${check.sharesSum} %)`);
        if (plan.mode === 'create' && !check.valid) {
            console.log('    ✗ Eine neue Vorlage muss «Hazır» sein — abgebrochen.');
            blocked = true;
        }
        const people = assigneesOf(input.tasks);
        if (people.length) {
            const active = await directory.activePeople(tenant.id, people);
            const dropped = people.filter((id) => !active.has(id));
            if (dropped.length) {
                console.log(`    ! ${dropped.length} inaktive Person(en) würden beim Speichern wegfallen: ${dropped.join(', ')}`);
                if (!ALLOW_DROP) { console.log('    ✗ abgebrochen (mit --allow-drop trotzdem schreiben).'); blocked = true; }
            }
        }
        console.log(`    → ${plan.changes ? `${plan.changes} Änderung(en)` : 'keine Änderung'}\n`);
    }

    const pending = plans.filter((plan) => plan.body && plan.changes > 0);
    console.log(`Zusammen: ${pending.length} Vorlage(n) zu schreiben, ${plans.reduce((sum, plan) => sum + plan.changes, 0)} Änderung(en).`);
    if (blocked) throw new Error('Nicht geschrieben — siehe ✗ oben.');
    if (DRY || !pending.length) return;

    // Sicherung: die rohen Unteraufgaben der Vorlagen, die geändert werden.
    const backupDir = path.join(__dirname, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = await Promise.all(pending.filter((plan) => plan.existing).map(async (plan) => ({
        templateId: plan.existing!.id,
        name: plan.existing!.name,
        tasks: await prisma.productionTaskTemplateTask.findMany({
            where: { templateId: plan.existing!.id },
            select: { id: true, code: true, name: true, area: true, stage: true, weight: true, stageWeight: true, assigneeIds: true, subtasks: true },
            orderBy: { sortOrder: 'asc' },
        }),
    })));
    const backupFile = path.join(backupDir, `occ-seed-${tenant.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ tenantId: tenant.id, at: new Date().toISOString(), templates: backup }, null, 2));
    console.log(`Sicherung: ${backupFile}`);

    for (const plan of pending) {
        if (!plan.body) continue;
        const saved = plan.mode === 'create'
            ? await useCase.create(tenant.id, actor, plan.body)
            : await useCase.update(tenant.id, actor, plan.existing!.id, plan.body);
        const problems = plan.existing ? sameExceptSubtasks(plan.existing, saved) : [];
        console.log(`✓ «${saved.name}» gespeichert (${saved.id}) — ${saved.check.valid ? 'Hazır' : 'EKSİK'}${problems.length ? ` — ACHTUNG: ${problems.join('; ')}` : ''}`);
    }
};

main()
    .catch((error: unknown) => {
        console.error('[occ-seed]', error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
