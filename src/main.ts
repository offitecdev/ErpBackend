import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './infrastructure/config/swagger.config';
import authRoutes     from './presentation/routes/auth.routes';
import employeeRoutes from './presentation/routes/employee.routes';
import leaveRoutes    from './presentation/routes/leave.routes';
import tenantRoutes  from './presentation/routes/tenant.routes';    
import customerRoutes from './presentation/routes/customer.routes';
import attendanceRoutes from './presentation/routes/attendance.routes';
import roleRoutes from './presentation/routes/role.routes';
import tenderRoutes from './presentation/routes/tender.routes';
import articleRoutes from './presentation/routes/article.routes';
import inventoryRoutes from './presentation/routes/inventory.routes';
import projectRoutes from './presentation/routes/project.routes';
import bookingRoutes from './presentation/routes/booking.routes';
import mailRoutes from './presentation/routes/mail.routes';
import logisticsRoutes from './presentation/routes/logistics.routes';
import regieRoutes from './presentation/routes/regie.routes';
import maintenanceRoutes from './presentation/routes/maintenance.routes';


const app  = express();
const PORT = process.env.PORT || 3000;
const apiPrefixes = ['/api/v1', '/backend/api/v1'];
const swaggerUiOptions = {
    customSiteTitle: 'OFFITEC ERP API Docs',
    swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'list',
    },
};
const allowSwaggerUi = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.removeHeader('Content-Security-Policy');
    next();
};

app.use(cors());
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('combined'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


app.use('/api-docs', allowSwaggerUi, swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));
app.use('/backend/api-docs', allowSwaggerUi, swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));

app.get(['/swagger.json', '/backend/swagger.json'], (_req, res) => {
    res.header('Content-Type', 'application/json');
    res.send(swaggerSpec);
});


app.get(['/health', '/backend/health'], (_req, res) => {
    res.status(200).json({ status: 'OK' });
});

for (const prefix of apiPrefixes) {
    app.use(`${prefix}/auth`, authRoutes);
    app.use(`${prefix}/employees`, employeeRoutes);
    app.use(`${prefix}/leaves`, leaveRoutes);
    app.use(`${prefix}/tenants`, tenantRoutes);
    app.use(`${prefix}/customers`, customerRoutes);
    app.use(`${prefix}/attendance`, attendanceRoutes);
    app.use(`${prefix}/roles`, roleRoutes);
    app.use(`${prefix}/tenders`, tenderRoutes);
    app.use(`${prefix}/articles`, articleRoutes);
    app.use(`${prefix}/inventory`, inventoryRoutes);
    app.use(`${prefix}/projects`, projectRoutes);
    app.use(`${prefix}/booking`, bookingRoutes);
    app.use(`${prefix}/mail`, mailRoutes);
    app.use(`${prefix}/logistics`, logisticsRoutes);
    app.use(`${prefix}/maintenance`, maintenanceRoutes);
    app.use(`${prefix}/regie`, regieRoutes);
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`API Docs  -> http://localhost:${PORT}/api-docs`);
    console.log(`API Docs  -> http://localhost:${PORT}/backend/api-docs`);
});
