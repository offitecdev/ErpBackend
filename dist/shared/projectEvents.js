"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emitProjectCreated = exports.onProjectCreated = void 0;
const handlers = [];
const onProjectCreated = (handler) => {
    handlers.push(handler);
};
exports.onProjectCreated = onProjectCreated;
const emitProjectCreated = (event) => {
    for (const handler of handlers) {
        try {
            handler(event);
        }
        catch (error) {
            console.warn('[projectEvents] handler failed', event.projectId, error?.message);
        }
    }
};
exports.emitProjectCreated = emitProjectCreated;
//# sourceMappingURL=projectEvents.js.map