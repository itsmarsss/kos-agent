/**
 * The seccomp filter every bubblewrap run is held to, as Flatpak's: the
 * system calls a jailed program has no business making, refused.
 *
 * Namespaces of its own (unshare, setns, clone or clone3 into a new user
 * namespace), the kernel's keyrings, BPF, perf, userfaultfd and io_uring,
 * where kernel bugs live, ptrace, every mount call, kexec and modules, a
 * tty's TIOCSTI and TIOCLINUX, which type into a terminal, and personality
 * flags past the plain ones. Built here as classic BPF, so nothing native
 * is needed: bwrap loads it with --seccomp.
 */

/** A program for one architecture: its audit id and its system call numbers. */
interface Arch {
  audit: number;
  /** Numbers at or past this are another ABI on the same kernel (x32), refused outright. */
  abiBit?: number;
  refused: number[];
  clone: number;
  clone3: number;
  ioctl: number;
  personality: number;
}

const ARCHES: Partial<Record<NodeJS.Architecture, Arch>> = {
  x64: {
    audit: 0xc000003e,
    abiBit: 0x40000000,
    // unshare setns chroot keyctl add_key request_key bpf perf_event_open userfaultfd io_uring_* ptrace
    // mount umount2 pivot_root open_tree move_mount fsopen fsconfig fsmount fspick mount_setattr
    // kexec_load kexec_file_load init_module finit_module delete_module
    refused: [272, 308, 161, 250, 248, 249, 321, 298, 323, 425, 426, 427, 101, 165, 166, 155, 428, 429, 430, 431, 432, 433, 442, 246, 320, 175, 313, 176],
    clone: 56,
    clone3: 435,
    ioctl: 16,
    personality: 135,
  },
  arm64: {
    audit: 0xc00000b7,
    refused: [97, 268, 51, 219, 217, 218, 280, 241, 282, 425, 426, 427, 117, 40, 39, 41, 428, 429, 430, 431, 432, 433, 442, 104, 294, 105, 273, 106],
    clone: 220,
    clone3: 435,
    ioctl: 29,
    personality: 92,
  },
};

const CLONE_NEWUSER = 0x10000000;
const TIOCSTI = 0x5412;
const TIOCLINUX = 0x541c;
/** PER_LINUX, PER_LINUX32, and the query that changes nothing. */
const PERSONALITIES = [0, 0x8, 0xffffffff];
const EPERM = 1;
const ENOSYS = 38;

const LD_ABS = 0x20;
const JEQ = 0x15;
const JGE = 0x35;
const JSET = 0x45;
const RET = 0x06;
const ALLOW = 0x7fff0000;
const KILL = 0x80000000;
const errno = (n: number): number => 0x00050000 | n;

/** Offsets in struct seccomp_data: the call's number, its architecture, the low word of an argument. */
const NR = 0;
const ARCH = 4;
const arg = (i: number): number => 16 + 8 * i;

type Insn = [code: number, jt: number, jf: number, k: number];

/** The filter for this machine, as bwrap reads it; undefined for an architecture without one. */
export function seccompFilter(arch: NodeJS.Architecture = process.arch): Buffer | undefined {
  const a = ARCHES[arch];
  if (!a) return undefined;
  const p: Insn[] = [
    [LD_ABS, 0, 0, ARCH],
    [JEQ, 1, 0, a.audit],
    [RET, 0, 0, KILL],
    [LD_ABS, 0, 0, NR],
  ];
  if (a.abiBit) p.push([JGE, 0, 1, a.abiBit], [RET, 0, 0, errno(EPERM)]);
  for (const nr of a.refused) p.push([JEQ, 0, 1, nr], [RET, 0, 0, errno(EPERM)]);
  // clone3's flags are behind a pointer: refused as missing, so the C library falls back to clone.
  p.push([JEQ, 0, 1, a.clone3], [RET, 0, 0, errno(ENOSYS)]);
  p.push([JEQ, 0, 4, a.clone], [LD_ABS, 0, 0, arg(0)], [JSET, 0, 1, CLONE_NEWUSER], [RET, 0, 0, errno(EPERM)], [RET, 0, 0, ALLOW]);
  // The kernel reads an ioctl's request as 32 bits, so the low word is the request.
  p.push([JEQ, 0, 5, a.ioctl], [LD_ABS, 0, 0, arg(1)], [JEQ, 2, 0, TIOCSTI], [JEQ, 1, 0, TIOCLINUX], [RET, 0, 0, ALLOW], [RET, 0, 0, errno(EPERM)]);
  p.push([JEQ, 0, 6, a.personality], [LD_ABS, 0, 0, arg(0)]);
  PERSONALITIES.forEach((value, i) => p.push([JEQ, PERSONALITIES.length - i, 0, value]));
  p.push([RET, 0, 0, errno(EPERM)], [RET, 0, 0, ALLOW]);
  p.push([RET, 0, 0, ALLOW]);
  const out = Buffer.alloc(p.length * 8);
  p.forEach(([code, jt, jf, k], i) => {
    out.writeUInt16LE(code, i * 8);
    out.writeUInt8(jt, i * 8 + 2);
    out.writeUInt8(jf, i * 8 + 3);
    out.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return out;
}
