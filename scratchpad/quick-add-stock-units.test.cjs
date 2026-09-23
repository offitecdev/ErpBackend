// Run: node --test scratchpad/quick-add-stock-units.test.cjs
// Isolated service regression tests. No application database is accessed.
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { receiveQuickStockUnit } = require('../src/application/services/quickAddStockUnit');

const model = (id = 'model-a', tenantId = 'tenant-a') => ({
    id, tenantId, articleCode: `ERP-${id}`, name: id, unit: 'pcs', modelNumber: id,
    supplierBarcode: `product-${id}`, systemBarcode: null, serialNumber: null,
    barcodes: [`alias-${id}`], deletedAt: null,
});
function fixture(articles = [model()]) {
    let state = { articles: structuredClone(articles), units: [], movements: [], balances: {} };
    let failMovement = false;
    const receive = async (fields) => {
        const draft = structuredClone(state);
        const detail = row => row && ({ ...row, stockBalances: [{ currentQuantity: draft.balances[row.id] || 0 }] });
        const tx = {
            stockUnit: {
                findFirst: async ({ where }) => draft.units.find(row => row.tenantId === where.tenantId && where.OR.some(clause => Object.entries(clause).every(([key, value]) => row[key] === value))),
                create: async ({ data }) => { draft.units.push(data); return data; },
            },
            article: {
                findMany: async ({ where }) => draft.articles.filter(row => row.tenantId === where.tenantId && row.deletedAt === null && where.OR.some(clause => Object.entries(clause).every(([key, value]) => key === 'barcodes' ? row.barcodes.includes(value.some.barcode) : row[key] === value))).map(detail),
                findFirst: async ({ where }) => detail(draft.articles.find(row => row.id === where.id && row.tenantId === where.tenantId && row.deletedAt === null)),
                create: async ({ data }) => { const row = { ...model(data.id), ...data }; draft.articles.push(row); return detail(row); },
            },
            stockMovement: { create: async ({ data }) => { if (failMovement) throw Error('movement unavailable'); draft.movements.push(data); return data; } },
            stockBalance: { upsert: async ({ create, update }) => {
                draft.balances[create.articleId] = draft.balances[create.articleId] === undefined ? create.currentQuantity : draft.balances[create.articleId] + update.currentQuantity.increment;
            } },
        };
        const result = await receiveQuickStockUnit(tx, {
            tenantId: 'tenant-a', employeeId: 'employee-a', locationId: 'warehouse-a',
            barcode: 'device-1', serialNumber: null, ...fields,
        });
        state = draft;
        return result;
    };
    return { receive, state: () => state, failMovement: () => { failMovement = true; } };
}

test('50 distinct device barcodes create 50 units and +50 stock under one article', async () => {
    const db = fixture();
    for (let i = 0; i < 50; i++) await db.receive({ articleId: 'model-a', barcode: `manufacturer-${i}` });
    const state = db.state();
    assert.equal(state.articles.length, 1);
    assert.equal(state.units.length, 50);
    assert.equal(state.balances['model-a'], 50);
    assert.equal(state.movements.length, 50);
    assert.ok(state.movements.every(row => row.quantity === 1 && row.origin === 'QUICK_ADD'));
    assert.deepEqual(state.articles[0].barcodes, ['alias-model-a']);
    assert.equal(state.articles[0].supplierBarcode, 'product-model-a');
});

test('duplicate device remains rejected in a later session without stock changes', async () => {
    const db = fixture();
    await db.receive({ articleId: 'model-a' });
    const before = structuredClone(db.state());
    await assert.rejects(db.receive({ articleId: 'model-a' }), { code: 'STOCK_UNIT_EXISTS' });
    assert.deepEqual(db.state(), before);
});

test('same serial with a different barcode is rejected', async () => {
    const db = fixture();
    await db.receive({ articleId: 'model-a', serialNumber: 'serial-1' });
    await assert.rejects(db.receive({ articleId: 'model-a', barcode: 'device-2', serialNumber: 'serial-1' }), { code: 'STOCK_UNIT_EXISTS' });
    assert.equal(db.state().units.length, 1);
});

test('unknown barcode alone never creates an article', async () => {
    const db = fixture();
    await assert.rejects(db.receive({}), { code: 'ARTICLE_REQUIRED' });
    assert.equal(db.state().articles.length, 1);
    assert.equal(db.state().units.length, 0);
});

test('product barcode, alias, model and ERP code resolve automatically', async () => {
    for (const barcode of ['product-model-a', 'alias-model-a', 'model-a', 'ERP-model-a']) {
        const db = fixture();
        const result = await db.receive({ barcode });
        assert.equal(result.article.id, 'model-a');
        assert.equal(result.createdArticle, false);
        assert.equal(result.article.totalQuantity, 1);
    }
});

test('explicit new article creates one article and stores identifiers only on the unit', async () => {
    const db = fixture([]);
    const result = await db.receive({ serialNumber: 'serial-1', newArticle: { articleCode: 'ERP-NEW', name: 'New model', modelNumber: 'new-model', unit: 'pcs' } });
    assert.equal(result.createdArticle, true);
    assert.equal(db.state().articles.length, 1);
    assert.equal(db.state().articles[0].serialNumber, null);
    assert.equal(db.state().units[0].serialNumber, 'serial-1');
    assert.equal(db.state().units[0].barcode, 'device-1');
    await db.receive({ articleId: result.article.id, barcode: 'device-2' });
    assert.equal(db.state().articles.length, 1);
    assert.equal(db.state().balances[result.article.id], 2);
});

test('known other model cannot replace the locked article', async () => {
    const db = fixture([model(), model('model-b')]);
    await assert.rejects(db.receive({ articleId: 'model-a', barcode: 'product-model-b' }), { code: 'ARTICLE_MISMATCH' });
    assert.equal(db.state().units.length, 0);
});

test('tenant boundaries and deleted articles are respected', async () => {
    const db = fixture([model('foreign', 'tenant-b'), { ...model('deleted'), deletedAt: new Date() }]);
    for (const articleId of ['foreign', 'deleted']) await assert.rejects(db.receive({ articleId }), { code: 'ARTICLE_NOT_FOUND' });
    assert.equal(db.state().units.length, 0);
});

test('a failed receipt propagates so the enclosing transaction rolls back article and device', async () => {
    const db = fixture([]);
    db.failMovement();
    await assert.rejects(db.receive({ newArticle: { articleCode: 'ERP-NEW', name: 'New model', modelNumber: null, unit: 'pcs' } }), /movement unavailable/);
    assert.deepEqual(db.state(), { articles: [], units: [], movements: [], balances: {} });
});

test('ambiguous model requires selection and then accepts that selection', async () => {
    const db = fixture([model(), { ...model('model-b'), modelNumber: 'model-a' }]);
    await assert.rejects(db.receive({ barcode: 'model-a' }), { code: 'ARTICLE_REQUIRED' });
    const result = await db.receive({ barcode: 'model-a', articleId: 'model-b' });
    assert.equal(result.article.id, 'model-b');
});
