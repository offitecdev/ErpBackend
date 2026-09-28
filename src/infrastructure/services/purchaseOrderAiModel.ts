import type { GptModelOptions } from './gptExtract';

/** Purchase document import has its own model; unrelated extraction keeps its configured model. */
export const purchaseOrderAiModel = (): string =>
    String(process.env.PURCHASE_ORDER_AI_MODEL ?? '').trim() || 'gpt-5.4-mini';

export const purchaseOrderAiOptions = (): GptModelOptions => {
    const model = purchaseOrderAiModel();
    // These models support none effort. Older explicit overrides retain their own transport default.
    const supportsNone = /^gpt-5\.4(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
    return { model, ...(supportsNone ? { reasoningEffort: 'none' } : {}) };
};
