import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // Seed data goes here once schema is finalised
  console.log('Seed complete.');
}

main()
  .catch((e: Error) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
