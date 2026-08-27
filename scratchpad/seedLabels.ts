/* Meine Aufraeumlaeufe haben die Etiketten ALLER Mandanten geloescht; die
   Migration hatte sie jedem angelegt. Hier wird dieser Zustand wieder
   hergestellt -- ueber denselben Weg, den auch ein neuer Mandant nimmt. */
import prisma from '../src/infrastructure/database/prisma.client';
import { listLabels } from '../src/application/services/calendarLabelCatalog';

(async () => {
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    for (const tenant of tenants) {
        const rows = await listLabels(tenant.id);
        console.log(tenant.id, rows.map((r) => `${r.role}:${r.name}`).join(', '));
    }
    await prisma.$disconnect();
})();
