import { describe, expect, it } from "vitest";

import { seccompFilter } from "./seccomp.js";

const ALLOW = 0x7fff0000;
const KILL = 0x80000000;
const EPERM = 0x00050001;
const ENOSYS = 0x00050026;
const X64 = 0xc000003e;

/** Run a classic BPF program over one call, as the kernel would: its number, architecture and arguments' low words. */
function verdict(program: Buffer, nr: number, args: number[] = [], arch = X64): number {
  const data = (offset: number): number => {
    if (offset === 0) return nr;
    if (offset === 4) return arch;
    return args[(offset - 16) / 8] ?? 0;
  };
  let acc = 0;
  for (let pc = 0; pc * 8 < program.length; pc++) {
    const code = program.readUInt16LE(pc * 8);
    const jt = program.readUInt8(pc * 8 + 2);
    const jf = program.readUInt8(pc * 8 + 3);
    const k = program.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) acc = data(k) >>> 0;
    else if (code === 0x06) return k;
    else if (code === 0x15) pc += acc === k ? jt : jf;
    else if (code === 0x35) pc += acc >= k ? jt : jf;
    else if (code === 0x45) pc += (acc & k) !== 0 ? jt : jf;
    else throw new Error(`unknown instruction ${code}`);
  }
  throw new Error("fell off the end");
}

describe("the bubblewrap seccomp filter", () => {
  const program = seccompFilter("x64")!;

  it("refuses namespaces, keyrings, BPF, io_uring, ptrace, mounts and modules, and allows the rest", () => {
    for (const nr of [272, 308, 250, 321, 298, 323, 425, 101, 165, 155, 246, 175, 313]) expect(verdict(program, nr), String(nr)).toBe(EPERM);
    for (const nr of [0, 1, 2, 59, 57, 231]) expect(verdict(program, nr), String(nr)).toBe(ALLOW);
  });

  it("refuses clone into a new user namespace and clone3 as missing, and lets a plain clone through", () => {
    expect(verdict(program, 56, [0x10000000 | 0x11])).toBe(EPERM);
    expect(verdict(program, 56, [0x01200011])).toBe(ALLOW);
    expect(verdict(program, 435)).toBe(ENOSYS);
  });

  it("refuses typing into a terminal, and odd personalities, and allows other ioctls", () => {
    expect(verdict(program, 16, [1, 0x5412])).toBe(EPERM);
    expect(verdict(program, 16, [1, 0x541c])).toBe(EPERM);
    expect(verdict(program, 16, [1, 0x5401])).toBe(ALLOW);
    expect(verdict(program, 135, [0])).toBe(ALLOW);
    expect(verdict(program, 135, [0xffffffff])).toBe(ALLOW);
    expect(verdict(program, 135, [0x0040000])).toBe(EPERM);
  });

  it("kills a call from another architecture, refuses the x32 ABI, and has no filter for an unknown machine", () => {
    expect(verdict(program, 1, [], 0x40000003)).toBe(KILL);
    expect(verdict(program, 0x40000001)).toBe(EPERM);
    expect(seccompFilter("arm64")).toBeDefined();
    expect(seccompFilter("ia32")).toBeUndefined();
  });
});
