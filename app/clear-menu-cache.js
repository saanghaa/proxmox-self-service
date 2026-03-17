// Clear menu config cache from database
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clearMenuCache() {
  try {
    console.log('🔄 Clearing menu config cache from database...');

    const result = await prisma.systemConfig.deleteMany({
      where: {
        OR: [
          { key: 'menu_config' },
          { key: 'section_labels' }
        ]
      }
    });

    console.log(`✅ Deleted ${result.count} cached config entries`);
    console.log('✅ Menu will now load from defaults/default-menu-config.json');
    console.log('');
    console.log('Next steps:');
    console.log('1. Restart server: npm run dev');
    console.log('2. Refresh browser: Ctrl + Shift + R');

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

clearMenuCache();
