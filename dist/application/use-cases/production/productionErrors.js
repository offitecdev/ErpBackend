"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productionErrorBody = exports.isProductionError = exports.productionError = void 0;
const productionError = (code, message, options = {}) => Object.assign(new Error(message), {
    code,
    status: options.status ?? 400,
    params: options.params,
    details: options.details,
});
exports.productionError = productionError;
const isProductionError = (error) => Boolean(error) && typeof error.code === 'string' && typeof error.status === 'number';
exports.isProductionError = isProductionError;
/** Antwortkörper eines Fehlers — Kennung, Werte und Zeilen reisen mit. */
const productionErrorBody = (error) => {
    const e = error;
    return {
        error: e?.message || 'Error',
        ...(e?.code ? { code: e.code } : {}),
        ...(e?.params ? { params: e.params } : {}),
        ...(e?.details !== undefined ? { details: e.details } : {}),
    };
};
exports.productionErrorBody = productionErrorBody;
//# sourceMappingURL=productionErrors.js.map