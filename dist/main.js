"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const swagger_config_1 = require("./infrastructure/config/swagger.config");
const auth_routes_1 = __importDefault(require("./presentation/routes/auth.routes"));
const employee_routes_1 = __importDefault(require("./presentation/routes/employee.routes"));
const leave_routes_1 = __importDefault(require("./presentation/routes/leave.routes"));
const tenant_routes_1 = __importDefault(require("./presentation/routes/tenant.routes"));
const customer_routes_1 = __importDefault(require("./presentation/routes/customer.routes"));
const attendance_routes_1 = __importDefault(require("./presentation/routes/attendance.routes"));
const role_routes_1 = __importDefault(require("./presentation/routes/role.routes"));
const tender_routes_1 = __importDefault(require("./presentation/routes/tender.routes"));
const article_routes_1 = __importDefault(require("./presentation/routes/article.routes"));
const inventory_routes_1 = __importDefault(require("./presentation/routes/inventory.routes"));
const project_routes_1 = __importDefault(require("./presentation/routes/project.routes"));
const booking_routes_1 = __importDefault(require("./presentation/routes/booking.routes"));
const mail_routes_1 = __importDefault(require("./presentation/routes/mail.routes"));
const logistics_routes_1 = __importDefault(require("./presentation/routes/logistics.routes"));
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
const apiPrefixes = ['/api/v1', '/backend/api/v1'];
const swaggerUiOptions = {
    customSiteTitle: 'OFFITEC ERP API Docs',
    swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'list',
    },
};
const allowSwaggerUi = (_req, res, next) => {
    res.removeHeader('Content-Security-Policy');
    next();
};
app.use((0, cors_1.default)());
app.use((0, helmet_1.default)({ crossOriginResourcePolicy: false }));
app.use((0, morgan_1.default)('combined'));
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ limit: '50mb', extended: true }));
app.use('/api-docs', allowSwaggerUi, swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_config_1.swaggerSpec, swaggerUiOptions));
app.use('/backend/api-docs', allowSwaggerUi, swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_config_1.swaggerSpec, swaggerUiOptions));
app.get(['/swagger.json', '/backend/swagger.json'], (_req, res) => {
    res.header('Content-Type', 'application/json');
    res.send(swagger_config_1.swaggerSpec);
});
app.get(['/health', '/backend/health'], (_req, res) => {
    res.status(200).json({ status: 'OK' });
});
for (const prefix of apiPrefixes) {
    app.use(`${prefix}/auth`, auth_routes_1.default);
    app.use(`${prefix}/employees`, employee_routes_1.default);
    app.use(`${prefix}/leaves`, leave_routes_1.default);
    app.use(`${prefix}/tenants`, tenant_routes_1.default);
    app.use(`${prefix}/customers`, customer_routes_1.default);
    app.use(`${prefix}/attendance`, attendance_routes_1.default);
    app.use(`${prefix}/roles`, role_routes_1.default);
    app.use(`${prefix}/tenders`, tender_routes_1.default);
    app.use(`${prefix}/articles`, article_routes_1.default);
    app.use(`${prefix}/inventory`, inventory_routes_1.default);
    app.use(`${prefix}/projects`, project_routes_1.default);
    app.use(`${prefix}/booking`, booking_routes_1.default);
    app.use(`${prefix}/mail`, mail_routes_1.default);
    app.use(`${prefix}/logistics`, logistics_routes_1.default);
}
app.use((err, _req, res, _next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`API Docs  -> http://localhost:${PORT}/api-docs`);
    console.log(`API Docs  -> http://localhost:${PORT}/backend/api-docs`);
});
//# sourceMappingURL=main.js.map