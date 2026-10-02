/**
 * ── OCC «SEVKİYAT» ALS STUFE VOR DEM FINAL (02.10.2026 abends, Vorgabe Samet) ──────────────
 *
 * «şimdi sevkiyat adımını eklemek istiyorum normal tasarımı değişmeden … bir ücretin de girilmesi
 *  gerekiyordu … sevkiyatla finale gelmesi gerekiyor … sevkiyat da seed olarak ekle». Der Weg
 * Mekanik der OCC-Vorlagen (Chiller, Dry Cooler, Isı Pompası) wird
 *
 *     … › Üretim/Montaj › Test › Sevkiyat › Final (Fahne)
 *
 * «Sevkiyat» ist eine EIGENE Stufe wie mit «Yeni aşama» (Schlüssel `g-sevkiyat`) — kein neuer
 * Stufentyp. Hinein kommen (PDF S. 7 «Test › Final QC › Sevkiyat Hazırlığı › Sevke Hazır ›
 * Yüklendi › Gönderildi»):
 *   · die Final-QC-Aufgabe, die bisher im Final stand (verschoben, Kürzel/Personen bleiben),
 *   · Nakliye planı (mit «Ücret» — Betrag in CHF), Sevkiyat hazırlığı, Sevke hazır onayı (Kilit),
 *     Yükleme ve sevkiyat (Kilit) — die Unteraufgaben, die bisher unter der Final-QC-Aufgabe
 *     hingen, wandern mit ihrer Kennung in eigene Aufgaben.
 * Ins Final kommt «Sevkiyat raporu ve makine dosyası» (PDF S. 6 §4, Kilit).
 * Gewichte: die Stufe Sevkiyat nimmt ihr Gewicht vom Final (Chiller 4 → 3 + 1, sonst 10 → 8 + 2);
 * alle anderen Stufen, Aufgaben, Gewichte und Personen bleiben.
 *
 *   npx ts-node scripts/seed-occ-shipping-stage.ts <tenantId> --dry    Vorschau, schreibt nichts
 *   npx ts-node scripts/seed-occ-shipping-stage.ts <tenantId>          schreiben (vorher Sicherung)
 *   Optionen: --actor <employeeId>
 *
 * Läuft nach `seed-occ-production-templates.ts`. Ein zweiter Lauf ändert nichts (Stufe nach
 * Schlüssel, Aufgaben nach Name, Unteraufgaben nach Name). Geräte bleiben unberührt — eine schon
 * geladene Kopie behält ihren Weg.
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
import type { ProductionSubtaskDto, ProductionTaskDto, ProductionTaskTemplateDto } from '../src/application/use-cases/production/productionTaskReadModel';
import { PRODUCTION_TASK_LIMITS, roundPercent, sameTaskCode, templateCheck, templateInputFrom } from '../src/domain/services/productionTasks';
import {
    OCC_FINAL_QC,
    OCC_MACHINE_FILE_TASK,
    OCC_SEED_TEMPLATES,
    OCC_SHIPPING_STAGE,
    OCC_SHIPPING_TASKS,
    type OccSeedSubtask,
    type OccShippingTask,
} from './occ-production-standard.data';

/* ── Aufruf ─────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const optionValue = (name: string): string | null => {
    const at = args.indexOf(name);
    const value = at >= 0 ? args[at + 1] : undefined;
    return value && !value.startsWith('--') ? value : null;
};
const ACTOR_ID = optionValue('--actor');
const TENANT_ID = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--actor') ?? null;

const MECH = 'MECHANICAL';

/* ── Wie der Server normalisiert ────────────────────────────────────────── */

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

/* ── Unteraufgaben ──────────────────────────────────────────────────────── */

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

interface TaskBody {
    area: string;
    stage: string;
    code: string;
    name: string;
    weight: number;
    assigneeIds: string[];
    startDate: null;
    dueDate: null;
    createdAt?: string | null;
    subtasks: SubtaskBody[];
}

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

const taskBodyOf = (task: ProductionTaskDto): TaskBody => ({
    area: task.area,
    stage: task.stage,
    code: task.code,
    name: task.name,
    weight: task.weight,
    assigneeIds: [],
    startDate: null,
    dueDate: null,
    createdAt: task.createdAt,
    subtasks: task.subtasks.map(bodyOfExisting),
});

/** Die Unteraufgabe, wie die Daten sie wollen — eine vorhandene behält Kennung, Personen und Gewicht. */
const wantedSubtask = (seed: OccSeedSubtask, kept: SubtaskBody | null): SubtaskBody => {
    const requiresDocument = seed.flags.includes('D');
    const requiresApproval = seed.flags.includes('O');
    const checklist = requiresApproval ? seed.checklist.map(oneLine).filter(Boolean) : [];
    const standards = requiresDocument && seed.standards ? multiline(seed.standards) : null;
    if (checklist.length > PRODUCTION_TASK_LIMITS.checklistItems) throw new Error(`«${seed.name}»: zu viele Punkte`);
    if ((standards ?? '').length > PRODUCTION_TASK_LIMITS.documentStandards) throw new Error(`«${seed.name}»: Standards zu lang`);
    return {
        ...(kept ?? { name: oneLine(seed.name), weight: null, startDate: null, dueDate: null, assigneeIds: [], documentStandardsFile: null }),
        requiresDocument,
        requiresApproval,
        photoAllowed: requiresDocument && seed.flags.includes('F'),
        feeRequired: seed.flags.includes('U'),
        priorStepsRequired: seed.flags.includes('K'),
        // Gleicher Text behält seine Kennung.
        approvalChecklist: checklist.map((text) => {
            const same = kept?.approvalChecklist.find((item) => item.text === text);
            return same?.id ? { id: same.id, text } : { text };
        }),
        documentStandards: standards,
        documentStandardsFile: requiresDocument ? kept?.documentStandardsFile ?? null : null,
    };
};

const sameSubtask = (left: SubtaskBody, right: SubtaskBody): boolean => JSON.stringify({ ...left, approvalChecklist: left.approvalChecklist.map((item) => item.text) })
    === JSON.stringify({ ...right, approvalChecklist: right.approvalChecklist.map((item) => item.text) });

/* ── Der Plan einer Vorlage ─────────────────────────────────────────────── */

interface Plan {
    template: ProductionTaskTemplateDto;
    body: { name: string; sections: ProductionTaskTemplateDto['sections']; tasks: TaskBody[] } | null;
    lines: string[];
    changes: number;
}

/** Das nächste freie Kürzel im Bereich Mekanik: M-15, M-16 … */
const nextCodes = (tasks: readonly TaskBody[]) => {
    let highest = tasks
        .filter((task) => task.area === MECH)
        .map((task) => Number(/^M-(\d+)$/i.exec(task.code.replace(/\s+/g, ''))?.[1] ?? 0))
        .reduce((max, value) => Math.max(max, value), 0);
    return () => {
        highest += 1;
        return `M-${String(highest).padStart(2, '0')}`;
    };
};

/** Der Gewichtsanteil, der beim Final bleibt (Chiller 4 → 1, sonst 10 → 2). */
const finalKeeps = (finalWeight: number): number => Math.min(finalWeight, Math.max(1, Math.round(finalWeight * 0.2)));

const planFor = (template: ProductionTaskTemplateDto): Plan => {
    const lines: string[] = [`  ~ Vorlage «${template.name}» (${template.id})`];
    let changes = 0;
    const sections = template.sections.map((section) => ({ ...section, stages: section.stages.map((stage) => ({ ...stage })) }));
    const mech = sections.find((section) => section.key === MECH);
    if (!mech) return { template, body: null, lines: [...lines, '    ! kein Bereich Mekanik — atlandı'], changes: 0 };
    const finalAt = mech.stages.findIndex((stage) => stage.key === 'final');
    if (finalAt < 0) return { template, body: null, lines: [...lines, '    ! Mekanik ohne Final — atlandı'], changes: 0 };

    // 1 · Die Stufe «Sevkiyat» direkt vor dem Final — ihr Gewicht kommt vom Final.
    if (!mech.stages.some((stage) => stage.key === OCC_SHIPPING_STAGE.key)) {
        const final = mech.stages[finalAt]!;
        const keep = finalKeeps(final.weight);
        const shippingWeight = roundPercent(final.weight - keep);
        mech.stages.splice(finalAt, 0, { key: OCC_SHIPPING_STAGE.key, name: OCC_SHIPPING_STAGE.name, weight: shippingWeight });
        lines.push(`    + Stufe «${OCC_SHIPPING_STAGE.name}» vor dem Final — Gewicht ${shippingWeight} % (Final ${final.weight} → ${keep} %)`);
        final.weight = keep;
        changes += 1;
    }

    const tasks = template.tasks.map(taskBodyOf);
    const nextCode = nextCodes(tasks);
    const inShipping = (task: TaskBody) => task.area === MECH && task.stage === OCC_SHIPPING_STAGE.key;
    const hasQc = (task: TaskBody) => task.subtasks.some((subtask) => sameName(subtask.name, OCC_FINAL_QC.subtaskName));

    // 2 · Die Final-QC-Aufgabe in die Stufe Sevkiyat (an den Anfang).
    const qcTask = tasks.find((task) => task.area === MECH && (task.stage === 'final' || inShipping(task)) && hasQc(task)) ?? null;
    if (!qcTask) lines.push(`    ! keine Aufgabe mit «${OCC_FINAL_QC.subtaskName}» — nur die neuen Aufgaben`);
    if (qcTask && qcTask.stage === 'final') {
        qcTask.stage = OCC_SHIPPING_STAGE.key;
        qcTask.weight = OCC_FINAL_QC.weight;
        lines.push(`    → ${qcTask.code} «${qcTask.name}» Final → Sevkiyat (Gewicht ${OCC_FINAL_QC.weight} %)`);
        changes += 1;
    }
    if (qcTask && sameName(qcTask.name, OCC_FINAL_QC.oldName)) {
        lines.push(`    ~ ${qcTask.code} umbenannt: «${qcTask.name}» → «${OCC_FINAL_QC.newName}»`);
        qcTask.name = OCC_FINAL_QC.newName;
        changes += 1;
    }

    // 3 · Die Schritte des PDF als eigene Aufgaben — vorhandene Unteraufgaben wandern mit ihrer Kennung.
    const pullFromQc = (name: string): SubtaskBody | null => {
        if (!qcTask) return null;
        const at = qcTask.subtasks.findIndex((subtask) => sameName(subtask.name, name));
        if (at < 0) return null;
        const [pulled] = qcTask.subtasks.splice(at, 1);
        return pulled ?? null;
    };
    const ensureTask = (seed: OccShippingTask, stage: string): TaskBody => {
        const existing = tasks.find((task) => task.area === MECH && task.stage === stage && sameName(task.name, seed.name));
        const pulled = pullFromQc(seed.subtask.name);
        if (existing) {
            const index = existing.subtasks.findIndex((subtask) => sameName(subtask.name, seed.subtask.name));
            const kept = index >= 0 ? existing.subtasks[index]! : pulled;
            const wanted = wantedSubtask(seed.subtask, kept);
            if (index < 0) {
                existing.subtasks.push(wanted);
                lines.push(`      + ${existing.code} «${wanted.name}»`);
                changes += 1;
            } else if (!sameSubtask(existing.subtasks[index]!, wanted)) {
                existing.subtasks[index] = wanted;
                lines.push(`      ~ ${existing.code} «${wanted.name}» güncellenir`);
                changes += 1;
            }
            return existing;
        }
        const wanted = wantedSubtask(seed.subtask, pulled);
        // Eine Unteraufgabe allein trägt kein eigenes Gewicht.
        wanted.weight = null;
        const created: TaskBody = {
            area: MECH,
            stage,
            code: nextCode(),
            name: seed.name,
            weight: seed.weight,
            assigneeIds: [],
            startDate: null,
            dueDate: null,
            subtasks: [wanted],
        };
        tasks.push(created);
        lines.push(`    + ${created.code} «${created.name}» (${stage === 'final' ? 'Final' : OCC_SHIPPING_STAGE.name}, ${seed.weight} %) — «${wanted.name}» ${pulled ? 'taşındı' : 'yeni'}`
            + `${wanted.feeRequired ? ' · Ücret' : ''}${wanted.priorStepsRequired ? ' · Kilit' : ''}`);
        changes += 1;
        return created;
    };
    for (const seed of OCC_SHIPPING_TASKS) ensureTask(seed, OCC_SHIPPING_STAGE.key);
    ensureTask(OCC_MACHINE_FILE_TASK, 'final');

    // Was die Final-QC-Aufgabe sonst noch trug, bleibt dort (nichts geht verloren).
    if (qcTask) {
        const left = qcTask.subtasks.map((subtask) => subtask.name);
        // Die übrig gebliebene Final-QC hat allein kein Teilgewicht mehr (vorher 1/5).
        if (qcTask.subtasks.length === 1 && qcTask.subtasks[0]!.weight !== null) {
            qcTask.subtasks[0]!.weight = null;
            changes += 1;
        }
        lines.push(`    = ${qcTask.code} trägt jetzt: ${left.join(' · ') || '—'}`);
    }

    // Final ohne andere Aufgaben: der Makine dosyası trägt die ganze Stufe.
    const finalTasks = tasks.filter((task) => task.area === MECH && task.stage === 'final');
    if (finalTasks.length === 1 && finalTasks[0]!.weight !== 100) {
        finalTasks[0]!.weight = 100;
        changes += 1;
    }

    return { template, body: { name: template.name, sections, tasks }, lines, changes };
};

/** Bleibt alles ausserhalb von Sevkiyat und Final, wie es war? */
const untouchedProblems = (before: ProductionTaskTemplateDto, after: ProductionTaskTemplateDto): string[] => {
    const problems: string[] = [];
    for (const task of before.tasks) {
        if (task.area === MECH && (task.stage === 'final' || task.stage === OCC_SHIPPING_STAGE.key)) continue;
        const now = after.tasks.find((entry) => sameTaskCode(entry.code, task.code) && entry.area === task.area);
        if (!now) { problems.push(`${task.code} fehlt`); continue; }
        if (now.name !== task.name || now.stage !== task.stage || Math.abs(now.weight - task.weight) > 0.01) problems.push(`${task.code} geändert`);
        if (JSON.stringify(now.subtasks.map((subtask) => [subtask.id, subtask.assigneeIds])) !== JSON.stringify(task.subtasks.map((subtask) => [subtask.id, subtask.assigneeIds]))) {
            problems.push(`${task.code} Unteraufgaben/Personen`);
        }
    }
    for (const section of before.sections) {
        const now = after.sections.find((entry) => entry.key === section.key);
        if (!now || Math.abs(now.share - section.share) > 0.01) problems.push(`Bereich ${section.key}`);
        for (const stage of section.stages) {
            if (section.key === MECH && stage.key === 'final') continue;
            const nowStage = now?.stages.find((entry) => entry.key === stage.key);
            if (!nowStage || Math.abs(nowStage.weight - stage.weight) > 0.01) problems.push(`Stufe ${section.key}/${stage.key}`);
        }
    }
    return problems;
};

/* ── Ablauf ─────────────────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
    if (!TENANT_ID) {
        console.log('Aufruf: npx ts-node scripts/seed-occ-shipping-stage.ts <tenantId> [--dry] [--actor <employeeId>]');
        return;
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: TENANT_ID }, select: { id: true, tenantName: true } });
    if (!tenant) throw new Error(`Firma ${TENANT_ID} gibt es nicht.`);
    console.log(`Firma: ${tenant.tenantName} (${tenant.id})${DRY ? ' — VORSCHAU (--dry), es wird nichts geschrieben' : ''}\n`);

    const repository = new PrismaProductionTaskTemplateRepository();
    const useCase = new ProductionTaskTemplatesUseCase(repository, new PrismaProductionTaskDirectory());
    const actor: ProductionTaskActor = { id: ACTOR_ID ?? (null as unknown as string), name: 'OCC seed' };

    const summaries = await repository.list(tenant.id);
    const plans: Plan[] = [];
    for (const seed of OCC_SEED_TEMPLATES) {
        const found = summaries.find((row) => sameName(row.name, seed.name));
        if (!found) { console.log(`  ! Vorlage «${seed.name}» gibt es nicht — erst seed-occ-production-templates.ts laufen lassen (atlandı)\n`); continue; }
        plans.push(planFor(await useCase.get(tenant.id, found.id)));
    }

    let blocked = false;
    for (const plan of plans) {
        console.log(plan.lines.join('\n'));
        if (!plan.body) { console.log(''); continue; }
        const input = templateInputFrom(plan.body);
        const check = templateCheck(input.sections, input.tasks);
        const mech = check.areas.find((area) => area.area === MECH);
        console.log(`    Summen: ${check.valid ? 'Hazır ✓' : 'EKSİK ✗'} · Mekanik Stufen ${mech?.weightSum ?? '—'} %`);
        if (plan.changes && !check.valid && plan.template.check.valid) {
            console.log('    ✗ Die Vorlage war «Hazır» und wäre es danach nicht mehr — abgebrochen.');
            blocked = true;
        }
        console.log(`    → ${plan.changes ? `${plan.changes} Änderung(en)` : 'keine Änderung'}\n`);
    }
    const pending = plans.filter((plan) => plan.body && plan.changes > 0);
    console.log(`Zusammen: ${pending.length} Vorlage(n) zu schreiben.`);
    if (blocked) throw new Error('Nicht geschrieben — siehe ✗ oben.');
    if (DRY || !pending.length) return;

    // Sicherung: die Vorlagen roh (Bereiche + Aufgaben), bevor sie geändert werden.
    const backupDir = path.join(__dirname, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = await Promise.all(pending.map(async (plan) => ({
        templateId: plan.template.id,
        name: plan.template.name,
        sections: (await prisma.productionTaskTemplate.findUnique({ where: { id: plan.template.id }, select: { sections: true } }))?.sections ?? null,
        tasks: await prisma.productionTaskTemplateTask.findMany({
            where: { templateId: plan.template.id },
            select: { id: true, code: true, name: true, area: true, stage: true, weight: true, stageWeight: true, assigneeIds: true, subtasks: true, sortOrder: true },
            orderBy: { sortOrder: 'asc' },
        }),
    })));
    const backupFile = path.join(backupDir, `occ-shipping-${tenant.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ tenantId: tenant.id, at: new Date().toISOString(), templates: backup }, null, 2));
    console.log(`Sicherung: ${backupFile}`);

    for (const plan of pending) {
        const saved = await useCase.update(tenant.id, actor, plan.template.id, plan.body);
        const problems = untouchedProblems(plan.template, saved);
        console.log(`✓ «${saved.name}» gespeichert — ${saved.check.valid ? 'Hazır' : 'EKSİK'}${problems.length ? ` — ACHTUNG: ${problems.join('; ')}` : ''}`);
    }
};

main()
    .catch((error: unknown) => {
        console.error('[occ-shipping]', error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
