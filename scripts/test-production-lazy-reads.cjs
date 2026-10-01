/* Regression checks for query boundaries and compact read models. No database connection. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText, filename);

const db = {};
const dbPath = require.resolve('../src/infrastructure/database/prisma.client.ts');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { __esModule: true, default: db } };
const { InvoiceRepository } = require('../src/infrastructure/repositories/InvoiceRepository.ts');
const { listProductionOrderPage } = require('../src/infrastructure/repositories/productionOrderList.ts');
const { DeviceBomsUseCase } = require('../src/application/use-cases/production/bom/DeviceBomsUseCase.ts');
const { BomRevisionsUseCase } = require('../src/application/use-cases/production/bom/BomRevisionsUseCase.ts');
const { BomProcurementUseCase } = require('../src/application/use-cases/production/bom/BomProcurementUseCase.ts');
const { bomLinesDto, bomSummaryDto } = require('../src/application/use-cases/production/bom/bomReadModel.ts');
const { GetProductionProjectDevicesUseCase } = require('../src/application/use-cases/production/GetProductionProjectDevicesUseCase.ts');
const { bomProcess, pendingLineIds } = require(path.resolve(__dirname, '../../ErpFront/offitec-frontend/src/pages/production/bom/device/bomProcess.ts'));
const forbidden = async () => { throw new Error('Unrequested detail was loaded'); };
const date = new Date('2026-09-30T09:00:00Z');

async function invoiceList() {
    const queries = [];
    db.$queryRaw = async (query) => {
        const sql = query.sql;
        queries.push(sql);
        if (sql.includes('AS allCount')) return [{ allCount: 3, openCount: 2, creditCount: 1 }];
        if (sql.includes('AS total')) return [{ total: 3 }];
        return [
            { id: 'invoice', kind: 'RECHNUNG', status: 'ISSUED', amount: 100, paidSum: 25, paidMoney: 25, creditSum: -10, invoiceNumber: 'RE-1', recipientName: 'Customer', createdAt: date },
            { id: 'credit', kind: 'GUTSCHRIFT', status: 'ISSUED', amount: -40, paidSum: -15, paidMoney: -15, invoiceNumber: 'GS-1', createdAt: date },
        ];
    };
    const page = await new InvoiceRepository().listPage({ tenantId: 'tenant', page: 2, pageSize: 20 });
    assert.equal(queries.length, 3, 'list must not read positions or reversal detail');
    assert.ok(queries.every((sql) => !sql.includes('InvoiceLineItem') && !sql.includes('i.sections') && !sql.includes('i.introText') && !sql.includes('so.paymentStages')));
    assert.ok(queries[0].includes('LIMIT 20 OFFSET 20'));
    assert.equal(page.items[0].openAmount, 65);
    assert.equal(page.items[1].openAmount, 25, 'credit refunds must retain their balance');
    assert.equal(page.items[0].paidAmount, 25);
    assert.ok(!('lineItems' in page.items[0]) && !('sections' in page.items[0]));
    assert.equal(page.counts.ALL, 3);
    queries.length = 0;
    await new InvoiceRepository().list({ tenantId: 'tenant', id: 'invoice' });
    assert.ok(queries.some((sql) => sql.includes('InvoiceLineItem')), 'invoice detail must still load its document positions');
}

async function orderList() {
    let findArgs, countArgs, orderedQuery;
    db.productionProject = {
        findMany: async (args) => { findArgs = args; return [{ id: 'project', sourceKind: 'PROJECT', projectNumber: 'P-1', projectName: 'Plant', customerName: 'Customer', sourceTenantId: 'source', orders: [{ orderNumber: 'AB-1', orderKind: 'PROJECT' }, { orderNumber: 'NT-1', orderKind: 'ADDON' }], _count: { items: 7 } }]; },
        count: async (args) => { countArgs = args; return 41; },
    };
    db.tenant = { findMany: async () => [{ id: 'source', tenantName: 'Factory' }] };
    db.$queryRaw = async (query) => { orderedQuery = query; return [{ projectId: 'project', ordered: 3n }]; };
    const result = await listProductionOrderPage('tenant', { page: 2, pageSize: 20, search: 'NT-1', kind: 'PROJECT' });
    assert.equal(findArgs.skip, 20);
    assert.equal(findArgs.take, 20);
    assert.deepEqual(findArgs.where, countArgs.where, 'search and counts must use the same scope');
    assert.equal(findArgs.where.tenantId, 'tenant');
    assert.equal(findArgs.where.OR[3].orders.some.orderNumber.contains, 'NT-1');
    assert.ok(!findArgs.select.items && !findArgs.select.salesTotal, 'list must not hydrate device positions or cost data');
    assert.ok(orderedQuery.values.includes('tenant') && orderedQuery.values.includes('project'));
    assert.equal(result.projects[0].sourceTenantName, 'Factory');
    assert.equal(result.projects[0].addonCount, 1);
    assert.deepEqual(result.projects[0].counts, { ordered: 3, total: 7 });
    db.productionProject.findMany = async () => [];
    db.tenant.findMany = forbidden;
    db.$queryRaw = forbidden;
    assert.deepEqual((await listProductionOrderPage('tenant', { page: 1, pageSize: 20 })).projects, [], 'empty pages must not query unrelated tenants or purchases');
}

function bomFixture() {
    const line = (id) => ({ id, productId: id, erpCode: id, name: id, brand: null, modelNumber: null, unit: 'Stk', quantity: 4, consumedQuantity: 0, note: null, product: null, coverage: { open: 4, reserved: 0, incoming: 0, incomingConfirmed: 0, missing: 4, serials: [] }, orders: [] });
    return {
        id: 'bom', bomNumber: 'BOM-1', kind: 'SUB', parentBomId: 'main', area: 'MECHANICAL', status: 'APPROVED',
        productionItemId: 'device', productionProjectId: 'project', templateName: 'Motor', revision: 1, revisionDraft: null,
        createdAt: date, updatedAt: date, approvedAt: date, approvedById: null, consumedAt: null,
        lines: [line('A'), line('B')], counts: { lines: 2, missing: 2, reserved: 0, ordered: 1 },
        completion: { ordered: false, confirmed: false, reserved: false, ready: false, subs: { total: 0, completed: 0 } },
        purchases: [{ kind: 'ORDER', checks: { confirmed: true } }],
        procurement: [
            { kind: 'PRICE', status: 'OPEN', requestNumber: 'TLP-1', lines: [{ bomLineId: 'A', quantity: 4 }] },
            { kind: 'PRICE', status: 'CANCELLED', requestNumber: 'TLP-2', lines: [{ bomLineId: 'B', quantity: 4 }] },
        ], goodsIn: [{ lineId: 'A', quantity: 1 }, { lineId: 'A', quantity: 2 }], revisions: [{ revision: 0 }, { revision: 1 }],
    };
}

function bomProjection() {
    const bom = bomFixture();
    const compact = bomLinesDto(bom);
    assert.deepEqual(bomProcess(compact), bomProcess(bom), 'process labels/counts must survive projection');
    assert.deepEqual([...pendingLineIds(compact, 'PRICE')], [...pendingLineIds(bom, 'PRICE')]);
    assert.equal(compact.activity.received.A, 3);
    assert.equal(compact.activity.goodsCount, 2);
    assert.equal(compact.activity.requestsCount, 2);
    assert.equal(compact.activity.priceRequests.B, undefined, 'cancelled requests must not block a line');
    for (const field of ['purchases', 'revisions', 'procurement', 'goodsIn']) assert.deepEqual(compact[field], []);
    const summary = bomSummaryDto(bom);
    assert.ok(!('lines' in summary) && !('purchases' in summary) && !('revisions' in summary));
    const main = { ...bom, kind: 'MAIN', lines: [], counts: { ...bom.counts, lines: 0 } };
    assert.deepEqual(bomProcess(main, [summary]), bomProcess(main, [bom]), 'parent progress must match full child data');
}

async function bomReadBoundaries() {
    const bom = bomFixture();
    let revisionOptions;
    const revisions = { listForBoms: async (_tenant, _ids, options) => {
        revisionOptions = options;
        return [{ id: 'draft', bomId: 'bom', status: 'DRAFT', revision: 2, reason: 'Replace motor', createdAt: date, updatedAt: date, createdById: null, approvedById: null, lines: [bom.lines[0]] }];
    }, purchaseRevisionsForBoms: forbidden };
    const boms = { get: async () => bom, listForDevice: async () => [bom] };
    const purchases = { linksForBoms: async () => [], pruneOrphans: async (_tenant, links) => links, orders: forbidden };
    const directory = { personNames: async () => new Map() };
    const reservations = { facts: async () => ({ products: new Map(), coverage: { lines: new Map(), free: new Map() } }) };
    const useCase = new DeviceBomsUseCase(boms, {}, {}, purchases, directory, {}, reservations, {}, {}, forbidden, forbidden, revisions);
    useCase.attachProcurement({ activityForBoms: async () => new Map([['bom', { requestsCount: 1, goodsCount: 1, priceRequests: { A: 'TLP-1' }, received: { A: 3 } }]]), forBoms: forbidden });
    const result = await useCase.get('tenant', 'bom', true);
    assert.deepEqual(revisionOptions, { draftOnly: true }, 'materials must only query the working revision');
    assert.equal(result.activity.received.A, 3);
    assert.equal(result.activity.requestedNeeding, 1);
    assert.equal(result.revisionDraft.revision, 2);
    assert.equal(result.revisionDraft.lines[0].id, 'A', 'the editable revision must remain available on the material tab');
    revisions.listForBoms = forbidden;
    await useCase.dtos('tenant', [bom], [bom], 'summary');
    const main = { ...bom, id: 'main', kind: 'MAIN', lines: [], parentBomId: null };
    boms.listForDevice = async () => [main, bom];
    directory.device = async () => ({ id: 'device', productionProjectId: 'project', name: 'Device', quantity: 1, isActive: true });
    directory.project = async () => ({ id: 'project', projectNumber: 'P-1', projectName: 'Plant' });
    directory.bomStageAssignees = async () => [];
    directory.deliveryDates = async () => new Map();
    useCase.settings = { get: async () => ({ maxPerArea: 2, codes: { MECHANICAL: [], ELECTRICAL: [] } }) };
    useCase.templates = { list: forbidden };
    const area = await useCase.view('tenant', { id: 'actor', isAdmin: true }, 'device', 'mechanical', true);
    assert.ok(!('boms' in area), 'navigation response must not duplicate the BOMs');
    assert.ok(!('lines' in area.subs[0]));
    assert.deepEqual(area.templates, []);
    boms.get = forbidden;
    boms.getHeader = async () => bom;
    revisions.listForBoms = async (_tenant, _ids, options) => { assert.deepEqual(options, { omitLines: true }); return []; };
    const history = await useCase.history('tenant', 'bom');
    assert.equal(history.revisions[0].revision, 0, 'history can include the baseline without loading material positions');
}

async function deviceHeader() {
    let filter;
    const projects = {
        getProject: async (tenantId, id) => { assert.equal(tenantId, 'tenant'); return { id, projectNumber: 'P-1', projectName: 'Plant' }; },
        listItems: async (_tenant, query) => { filter = query; return [{ id: 'device', isActive: true, productionOrderId: 'order', name: 'Pump' }]; },
        listOrders: async () => [{ id: 'order', orderNumber: 'AB-1', orderKind: 'PROJECT' }],
    };
    const useCase = new GetProductionProjectDevicesUseCase(projects, { byPosition: forbidden }, { list: forbidden }, { read: forbidden });
    const header = await useCase.header('tenant', 'project', 'device');
    assert.deepEqual(filter, { projectIds: ['project'], itemIds: ['device'] });
    assert.equal(header.device.salesOrderNumber, 'AB-1');
    assert.ok(!('details' in header) && !('devices' in header));
    await assert.rejects(() => useCase.header('tenant', 'project', 'missing'), (error) => error.status === 404);
}

async function revisionResponse() {
    let loaded;
    const useCase = Object.create(BomRevisionsUseCase.prototype);
    Object.assign(useCase, {
        devices: {
            requireBom: async () => bomFixture(), assertCanEdit: async () => {},
            get: async (...args) => { loaded = args; return { id: 'bom' }; },
        },
        revisions: { deleteDraft: async () => true },
    });
    await useCase.discard('tenant', { id: 'actor' }, 'bom');
    assert.deepEqual(loaded, ['tenant', 'bom', true], 'revision actions must refresh the material view without loading the archives');
}

async function tabBoundaries() {
    const requests = { list: forbidden };
    const goods = { forBoms: async () => [] };
    // Method only uses these repositories and directory; no other services are needed.
    const useCase = Object.create(BomProcurementUseCase.prototype);
    Object.assign(useCase, { requests, goodsIn: goods, directory: { personNames: forbidden } });
    await useCase.forBoms('tenant', ['bom'], [], { section: 'goods' });
    requests.list = async () => [];
    goods.forBoms = forbidden;
    await useCase.forBoms('tenant', ['bom'], [], { section: 'requests' });
    requests.activityForBoms = async () => [
        { bomId: 'bom', kind: 'PRICE', status: 'OPEN', requestNumber: 'TLP-1', lineIds: ['A'] },
        { bomId: 'bom', kind: 'PRICE', status: 'CANCELLED', requestNumber: 'TLP-2', lineIds: ['B'] },
    ];
    goods.totalsForBoms = async () => [{ bomId: 'bom', lineId: 'A', quantity: 7, count: 3 }];
    const activity = (await useCase.activityForBoms('tenant', ['bom'])).get('bom');
    assert.equal(activity.requestsCount, 2);
    assert.equal(activity.goodsCount, 3);
    assert.deepEqual(activity.priceRequests, { A: 'TLP-1' });
    assert.deepEqual(activity.received, { A: 7 });
}

(async () => {
    await invoiceList();
    await orderList();
    bomProjection();
    await bomReadBoundaries();
    await tabBoundaries();
    await deviceHeader();
    await revisionResponse();
    console.log('PASS: invoice summaries, paged production orders, BOM process parity, revision and tab query boundaries');
})().catch((error) => { console.error(error); process.exitCode = 1; });
