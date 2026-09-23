import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
  const rows: any[] = await prisma.$queryRawUnsafe(
    "SELECT imageUrl FROM Article WHERE imageUrl LIKE 'r2:%' LIMIT 5"
  );
  rows.forEach((r) => console.log(r.imageUrl));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
