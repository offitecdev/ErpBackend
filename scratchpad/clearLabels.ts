/* Die Rauchprobe hinterlässt Etiketten, wenn sie abgebrochen wird — hier weg
   damit, die Liste soll für den Betrieb leer beginnen. */
import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
    const gone = await prisma.calendarLabel.deleteMany({});
    console.log('geloescht:', gone.count);
    console.log('verbleibend:', await prisma.calendarLabel.count());
    await prisma.$disconnect();
})();
