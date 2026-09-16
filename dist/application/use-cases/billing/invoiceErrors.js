"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invoiceErrorBody = exports.invoiceError = void 0;
const invoiceError = (code, message, options = {}) => Object.assign(new Error(message), {
    code,
    status: options.status ?? 400,
    params: options.params,
});
exports.invoiceError = invoiceError;
/** Antwortkörper eines Fehlers — Kennung und Werte reisen mit. */
const invoiceErrorBody = (error) => {
    const e = error;
    return {
        error: e?.message || 'Error',
        ...(e?.code ? { code: e.code } : {}),
        ...(e?.params ? { params: e.params } : {}),
    };
};
exports.invoiceErrorBody = invoiceErrorBody;
//# sourceMappingURL=invoiceErrors.js.map