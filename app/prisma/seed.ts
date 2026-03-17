import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // 기본 그룹 생성 (최초 관리자 계정은 웹 /setup 에서 생성)
  await prisma.group.upsert({
    where: { name: 'ADMIN' },
    update: {},
    create: { name: 'ADMIN' },
  });

  // 4. 배포 템플릿 시드 (AWS 인스턴스 사이즈 스타일)
  const templates = [
    { name: 'SMALL',   displayName: 'Small',        cpuCores: 2,  memoryMb: 4096,  diskSizeGb: 50,  sortOrder: 1, description: '2 vCPU / 4GB RAM / 50GB Disk — 경량 서비스, 개발용' },
    { name: 'MEDIUM',  displayName: 'Medium',       cpuCores: 4,  memoryMb: 8192,  diskSizeGb: 100, sortOrder: 2, description: '4 vCPU / 8GB RAM / 100GB Disk — 일반 웹/API 서버' },
    { name: 'LARGE',   displayName: 'Large',        cpuCores: 8,  memoryMb: 16384, diskSizeGb: 100, sortOrder: 3, description: '8 vCPU / 16GB RAM / 100GB Disk — WAS, 미들웨어' },
    { name: 'XLARGE',  displayName: 'X-Large',      cpuCores: 16, memoryMb: 32768, diskSizeGb: 100, sortOrder: 4, description: '16 vCPU / 32GB RAM / 100GB Disk — DB, 고성능 워크로드' },
    { name: '2XLARGE', displayName: '2X-Large',     cpuCores: 32, memoryMb: 65536, diskSizeGb: 100, sortOrder: 5, description: '32 vCPU / 64GB RAM / 100GB Disk — 대규모 DB, 분석용' },
  ];

  for (const t of templates) {
    await prisma.deployTemplate.upsert({
      where: { name: t.name },
      update: { displayName: t.displayName, cpuCores: t.cpuCores, memoryMb: t.memoryMb, diskSizeGb: t.diskSizeGb, sortOrder: t.sortOrder, description: t.description },
      create: t,
    });
  }

  // 5. 기본 UI 테마 템플릿 설정 (초기 설치 기본값: proxmox)
  await prisma.systemConfig.upsert({
    where: { key: 'theme_template' },
    update: {
      value: 'proxmox',
      updatedAt: new Date(),
    },
    create: {
      key: 'theme_template',
      value: 'proxmox',
    },
  });

  console.log('Seed 완료: ADMIN 그룹, 배포 템플릿 5종, 기본 테마(proxmox) 생성 (최초 관리자 계정은 웹 /setup 에서 생성)');
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
