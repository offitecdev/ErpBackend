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


const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('combined'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'OFFITEC ERP API Docs',
    swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'list',
    },
}));

app.get('/swagger.json', (_req, res) => {
    res.header('Content-Type', 'application/json');
    res.send(swaggerSpec);
});


app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'OK' });
});

app.use('/api/v1/auth',       authRoutes);
app.use('/api/v1/employees',  employeeRoutes);
app.use('/api/v1/leaves',     leaveRoutes);
app.use('/api/v1/tenants',    tenantRoutes);
app.use('/api/v1/customers',  customerRoutes);
app.use('/api/v1/attendance', attendanceRoutes);
app.use('/api/v1/roles',      roleRoutes);
app.use('/api/v1/tenders',    tenderRoutes);
app.use('/api/v1/articles',   articleRoutes);
app.use('/api/v1/articles',   articleRoutes);
app.use('/api/v1/inventory',  inventoryRoutes); 
app.use('/api/v1/projects', projectRoutes);
app.use('/api/v1/booking', bookingRoutes); 
app.use('/api/v1/mail', mailRoutes);
app.use('/api/v1/logistics', logisticsRoutes);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`API Docs  → http://localhost:${PORT}/api-docs`);
});
