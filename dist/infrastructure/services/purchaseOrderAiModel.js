"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.purchaseOrderAiOptions = exports.purchaseOrderAiModel = void 0;
/** Purchase document import has its own model; unrelated extraction keeps its configured model. */
const purchaseOrderAiModel = () => String(process.env.PURCHASE_ORDER_AI_MODEL ?? '').trim() || 'gpt-5.4-mini';
exports.purchaseOrderAiModel = purchaseOrderAiModel;
const purchaseOrderAiOptions = () => {
    const model = (0, exports.purchaseOrderAiModel)();
    // These models support none effort. Older explicit overrides retain their own transport default.
    const supportsNone = /^gpt-5\.4(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
    return { model, ...(supportsNone ? { reasoningEffort: 'none' } : {}) };
};
exports.purchaseOrderAiOptions = purchaseOrderAiOptions;
//# sourceMappingURL=purchaseOrderAiModel.js.map