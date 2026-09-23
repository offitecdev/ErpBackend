import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
  const rows: any[] = await prisma.$queryRawUnsafe(
    "SELECT LOWER(SUBSTRING_INDEX(imageUrl,'.',-1)) AS ext, COUNT(*) AS n FROM Article WHERE imageUrl LIKE 'r2:%' GROUP BY 1 ORDER BY 2 DESC"
  );
  rows.forEach((r) => console.log(`${r.ext}\t${Number(r.n)}`));
  const dup: any[] = await prisma.$queryRawUnsafe(
    "SELECT COUNT(DISTINCT imageUrl) AS distinctRefs, COUNT(*) AS total FROM Article WHERE imageUrl LIKE 'r2:%'"
  );
  console.log('distinct refs:', Number(dup[0].distinctRefs), '/ total', Number(dup[0].total));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
