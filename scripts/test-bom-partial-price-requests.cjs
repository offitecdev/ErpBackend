/* In-memory regression checks; no database or mail connection is opened. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    module._compile(ts.transpileModule(source, {
        fileName: filename,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText, filename);
};

const { BomProcurementUseCase } = require('../src/application/use-cases/production/bom/BomProcurementUseCase.ts');
const { DeviceBomsUseCase } = require('../src/application/use-cases/production/bom/DeviceBomsUseCase.ts');
const { remainingPriceRequestQuantities } = require('../src/domain/services/productionBomProcurement.ts');
const { priceRequestRemaining, pendingLineIds } = require(path.resolve(__dirname, '../../ErpFront/offitec-frontend/src/pages/production/bom/device/bomProcess.ts'));

const actor = { id: 'person', name: 'Buyer', isAdmin: true };
const sourceLines = [['A', 10], ['B', 8], ['C', 3], ['D', 2]].map(([id, quantity]) => ({
    id, productId: id, name: id, erpCode: id, brand: null, modelNumber: null, unit: 'PIECE', quantity, consumedQuantity: 0, note: null,
}));
const bom = { id: 'bom', bomNumber: 'BOM-1', status: 'DRAFT', revision: 0, lines: sourceLines, consumedAt: null, productionProjectId: 'project', productionItemId: 'item', area: 'MECHANICAL' };
const requests = [];
let workingRevision = 0;
const products = new Map(sourceLines.map((line) => [line.id, { ...line, suppliers: [{ supplierId: 'supplier', name: 'Supplier' }] }]));
const requestRepo = {
    list: async () => requests,
    create: async (_tenant, input, userId) => {
        const request = { ...input, id: `r${requests.length + 1}`, requestNumber: `TLP-${requests.length + 1}`, status: 'OPEN', createdAt: new Date(), createdById: userId, purchaseOrderIds: [] };
        requests.push(request);
        return request;
    },
};
const stock = { products: async () => products };
const snapshot = () => ({ ...bom, procurement: requests.map((entry) => ({ ...entry, lines: entry.lines.map(({ bomLineId, quantity }) => ({ bomLineId, quantity })) })) });
const devices = {
    requireBom: async () => bom, assertCanEdit: async () => {},
    workingLinesOf: async () => ({ draft: true, revision: workingRevision, lines: sourceLines }),
    get: async () => snapshot(),
};
const procurement = new BomProcurementUseCase(requestRepo, {}, {}, stock, {}, {}, devices);
const create = (lines) => procurement.createFromBom('tenant', actor, 'bom', { kind: 'PRICE', lines: lines.map(([lineId, quantity]) => ({ lineId, quantity })) });
const expectRemaining = (expected) => {
    assert.deepEqual(Object.fromEntries(remainingPriceRequestQuantities(sourceLines, 0, requests)), expected);
    assert.deepEqual(Object.fromEntries(priceRequestRemaining(snapshot())), expected, 'frontend and backend must agree');
};

async function run() {
    await create([['A', 3], ['B', 2]]);
    await create([['A', 2]]);
    expectRemaining({ A: 5, B: 6, C: 3, D: 2 });
    assert.equal(pendingLineIds(snapshot(), 'PRICE').has('A'), false, 'partial A must stay selectable');
    await create([['C', 3]]); // Third request, another product.
    await create([['A', 5]]); // Fourth request, remainder of the first product.
    await create([['B', 6], ['D', 2]]); // Fifth request, remaining products together.
    expectRemaining({ A: 0, B: 0, C: 0, D: 0 });
    assert.equal(pendingLineIds(snapshot(), 'PRICE').size, 4);
    await assert.rejects(() => create([['A', 1]]), (error) => error.code === 'LINE_INVALID');
    assert.equal(requests.length, 5, 'exhausted lines must not create duplicate requests');
    requests[4].status = 'CANCELLED';
    expectRemaining({ A: 0, B: 6, C: 0, D: 2 });
    await assert.rejects(() => create([['D', 1], ['D', 1]]), (error) => error.code === 'LINE_INVALID');
    assert.equal(requests.length, 5, 'duplicate payload lines must not be written');
    workingRevision = 1;
    await create([['A', 1]]);
    assert.equal(requests[5].bomRevision, 1, 'older revisions must not block new revision requests');
    const revisionBom = { ...snapshot(), status: 'APPROVED', revisionDraft: { revision: 1, lines: sourceLines } };
    assert.equal(priceRequestRemaining(revisionBom).get('A'), 9);

    // A prior partial request for the same supplier must not disable a new request.
    const current = requests[1];
    current.purchaseOrderIds = ['current-quote'];
    const quote = (id, lineId) => ({ link: { kind: 'REQUEST' }, order: { id, referenceNumber: id, supplierName: 'Supplier', items: [{ bomLineId: lineId, quantity: 2 }] } });
    const written = [];
    const directory = { project: async () => null, device: async () => null };
    const purchaseRepo = { createLink: async () => {} };
    const writer = { createRequest: async (input) => { written.push(input); return { id: 'new-quote', referenceNumber: 'PA-3', supplierName: input.supplier.supplierName }; } };
    const useCase = new DeviceBomsUseCase({}, {}, stock, purchaseRepo, directory, {}, {}, {}, writer, async () => null, async () => 'PA-3', {});
    useCase.requireBom = async () => bom;
    useCase.workingLinesOf = async () => ({ draft: true, revision: 0, lines: sourceLines });
    useCase.purchasesOf = async () => [quote('older-quote', 'A'), quote('current-quote', 'A'), quote('other-line', 'B')];
    useCase.get = async () => snapshot();
    useCase.attachProcurement({ assertUsable: async () => current, attachDocuments: async () => {} });
    const proposal = await useCase.requestProposal('tenant', actor, 'bom', current.id);
    assert.deepEqual(proposal.lines.map((line) => [line.lineId, line.quantity]), [['A', 2]], 'proposal must contain this request and its quantity');
    assert.deepEqual(proposal.lines[0].requests.map((entry) => entry.purchaseOrderId), ['current-quote'], 'old requests must not disable suppliers');
    current.purchaseOrderIds = [];
    const freshProposal = await useCase.requestProposal('tenant', actor, 'bom', current.id);
    assert.deepEqual(freshProposal.lines[0].requests, []);
    const suppliers = [{ supplierId: 'supplier', supplierName: 'Supplier' }];
    await assert.rejects(() => useCase.createRequests('tenant', actor, 'bom', { procurementRequestId: current.id, lines: [{ lineId: 'B', quantity: 1, suppliers }] }), (error) => error.code === 'LINE_UNKNOWN');
    const result = await useCase.createRequests('tenant', actor, 'bom', { procurementRequestId: current.id, lines: [{ lineId: 'A', quantity: 2, suppliers }] });
    assert.equal(result.created.length, 1);
    assert.equal(written[0].lines[0].quantity, 2);
    console.log('PASS: five partial requests, remaining products, exhausted/duplicate rejection, cancellation, revision, scoped supplier history and document creation.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
