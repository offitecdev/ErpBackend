const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('Fetching articles...');
  const articles = await prisma.$queryRaw`SELECT * FROM Article`;

  // Track seen systemBarcodes and (tenantId + articleCode) combinations
  const seenSystemBarcodes = new Set();
  const seenTenantArticleCodes = new Set();

  for (const article of articles) {
    let needsUpdate = false;
    let newSystemBarcode = article.systemBarcode;
    let newArticleCode = article.articleCode;

    if (article.systemBarcode) {
      if (seenSystemBarcodes.has(article.systemBarcode)) {
        newSystemBarcode = `${article.systemBarcode}-${Math.random().toString(36).substring(7)}`;
        needsUpdate = true;
      } else {
        seenSystemBarcodes.add(article.systemBarcode);
      }
    }

    if (article.articleCode) {
      const tenantCodeKey = `${article.tenantId}-${article.articleCode}`;
      if (seenTenantArticleCodes.has(tenantCodeKey)) {
        newArticleCode = `${article.articleCode}-${Math.random().toString(36).substring(7)}`;
        needsUpdate = true;
      } else {
        seenTenantArticleCodes.add(tenantCodeKey);
      }
    }

    if (needsUpdate) {
      console.log(`Updating duplicate article ${article.id}...`);
      await prisma.$executeRaw`UPDATE Article SET systemBarcode = ${newSystemBarcode}, articleCode = ${newArticleCode} WHERE id = ${article.id}`;
    }
  }

  console.log('Done resolving duplicates.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
