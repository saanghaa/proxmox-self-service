/**
 * db-delete-vm.ts
 *
 * 삭제 예정 VM(소프트 삭제 상태)을 Proxmox 건드리지 않고 DB에서만 제거하는 스크립트.
 *
 * 사용법:
 *   npx tsx src/scripts/db-delete-vm.ts                  # 삭제 예정 VM 목록 조회
 *   npx tsx src/scripts/db-delete-vm.ts <id>             # 특정 VM DB 삭제 (내부 ID)
 *   npx tsx src/scripts/db-delete-vm.ts --vmid <vmid>    # 특정 VM DB 삭제 (Proxmox VMID)
 *   npx tsx src/scripts/db-delete-vm.ts --all            # 전체 소프트 삭제 VM 일괄 DB 삭제
 */

import { PrismaClient } from '@prisma/client';
import * as readline from 'readline';

const prisma = new PrismaClient();

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function formatVm(vm: { id: string; vmid: number | null; hostname: string | null; ip: string | null; deletedAt: Date | null; group: { name: string } }) {
  return `  [${vm.vmid ?? '-'}] ${vm.hostname ?? '(no hostname)'}  IP: ${vm.ip ?? '-'}  그룹: ${vm.group.name}  삭제됨: ${vm.deletedAt?.toLocaleDateString('ko-KR') ?? '-'}  (id: ${vm.id})`;
}

async function listPending() {
  const vms = await prisma.vm.findMany({
    where: { deletedAt: { not: null } },
    include: { group: { select: { name: true } } },
    orderBy: { deletedAt: 'asc' },
  });

  if (vms.length === 0) {
    console.log('삭제 예정 VM이 없습니다.');
    return;
  }

  console.log(`\n삭제 예정 VM 목록 (총 ${vms.length}개):\n`);
  vms.forEach(vm => console.log(formatVm(vm)));
  console.log();
}

async function deleteOne(vm: { id: string; vmid: number | null; hostname: string | null; ip: string | null; deletedAt: Date | null; group: { name: string } }) {
  console.log(`\n삭제 대상:\n${formatVm(vm)}\n`);
  const answer = await ask('Proxmox VM은 그대로 유지하고 DB 레코드만 삭제합니다. 계속하시겠습니까? (y/N) ');
  if (answer.toLowerCase() !== 'y') {
    console.log('취소되었습니다.');
    return false;
  }

  await prisma.vm.delete({ where: { id: vm.id } });
  console.log(`✓ 삭제 완료: [${vm.vmid ?? '-'}] ${vm.hostname ?? vm.id}`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);

  // 인수 없음 → 목록 출력
  if (args.length === 0) {
    await listPending();
    await prisma.$disconnect();
    return;
  }

  // --all → 전체 일괄 삭제
  if (args[0] === '--all') {
    const vms = await prisma.vm.findMany({
      where: { deletedAt: { not: null } },
      include: { group: { select: { name: true } } },
      orderBy: { deletedAt: 'asc' },
    });

    if (vms.length === 0) {
      console.log('삭제 예정 VM이 없습니다.');
      await prisma.$disconnect();
      return;
    }

    console.log(`\n삭제 예정 VM 목록 (총 ${vms.length}개):\n`);
    vms.forEach(vm => console.log(formatVm(vm)));

    const answer = await ask(`\n위 ${vms.length}개 VM을 DB에서 전부 삭제합니다. Proxmox VM은 유지됩니다. 계속하시겠습니까? (y/N) `);
    if (answer.toLowerCase() !== 'y') {
      console.log('취소되었습니다.');
      await prisma.$disconnect();
      return;
    }

    await prisma.vm.deleteMany({ where: { deletedAt: { not: null } } });
    console.log(`✓ ${vms.length}개 VM DB 레코드 삭제 완료.`);
    await prisma.$disconnect();
    return;
  }

  // --vmid <number> → Proxmox VMID로 검색
  if (args[0] === '--vmid' && args[1]) {
    const vmid = parseInt(args[1], 10);
    if (isNaN(vmid)) {
      console.error('오류: 유효하지 않은 VMID입니다.');
      process.exit(1);
    }

    const vm = await prisma.vm.findFirst({
      where: { vmid, deletedAt: { not: null } },
      include: { group: { select: { name: true } } },
    });

    if (!vm) {
      console.error(`오류: VMID ${vmid}에 해당하는 소프트 삭제 VM을 찾을 수 없습니다.`);
      process.exit(1);
    }

    await deleteOne(vm);
    await prisma.$disconnect();
    return;
  }

  // <id> → 내부 ID로 검색
  const id = args[0];
  const vm = await prisma.vm.findUnique({
    where: { id },
    include: { group: { select: { name: true } } },
  });

  if (!vm) {
    console.error(`오류: ID '${id}'에 해당하는 VM을 찾을 수 없습니다.`);
    process.exit(1);
  }

  if (!vm.deletedAt) {
    console.error(`오류: VM [${vm.vmid}] ${vm.hostname}은 소프트 삭제 상태가 아닙니다. 먼저 삭제 예정으로 이동하세요.`);
    process.exit(1);
  }

  await deleteOne(vm);
  await prisma.$disconnect();
}

main().catch(err => {
  console.error('오류:', err.message);
  prisma.$disconnect();
  process.exit(1);
});
