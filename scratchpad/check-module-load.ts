/* Nur LADEN, nichts starten: zieht jeden geaenderten Router/Controller einmal
   herein. Faengt Ringimporte und Tippfehler, die erst zur Laufzeit auffallen. */
import '../src/presentation/controllers/serviceTenantScope';
import '../src/presentation/controllers/EmployeeController';
import '../src/presentation/controllers/MaintenanceController';
import '../src/presentation/controllers/ProjectController';
import '../src/presentation/controllers/TenantController';
import '../src/presentation/controllers/technicianSchedule';
import '../src/presentation/middlewares/AuthMiddleware';
import '../src/presentation/routes/employee.routes';
import '../src/presentation/routes/authorization.routes';
import '../src/presentation/routes/personnel.routes';
import '../src/presentation/routes/personnelHr.routes';
import '../src/presentation/routes/passwordRequest.routes';
import '../src/presentation/routes/role.routes';
import '../src/presentation/routes/roleTemplate.routes';
import '../src/presentation/routes/mailbox.routes';
import '../src/presentation/routes/crmTask.routes';
import '../src/presentation/routes/osp.routes';
import '../src/application/services/personnelReports';
import '../src/application/services/personnelProfile';
import '../src/infrastructure/services/leaveRequestMailService';
import '../src/infrastructure/services/outlook/mailCustomerMatcher';

console.log('Alle geaenderten Module geladen — keine Ringimporte, keine Fehler beim Laden.');
process.exit(0);
