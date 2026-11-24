// work/avr-bridge/node_modules/avr8js/dist/esm/cpu/interrupt.js
function avrInterrupt(cpu, addr) {
  const sp = cpu.dataView.getUint16(93, true);
  cpu.data[sp] = cpu.pc & 255;
  cpu.data[sp - 1] = cpu.pc >> 8 & 255;
  if (cpu.pc22Bits) {
    cpu.data[sp - 2] = cpu.pc >> 16 & 255;
  }
  cpu.dataView.setUint16(93, sp - (cpu.pc22Bits ? 3 : 2), true);
  cpu.data[95] &= 127;
  cpu.cycles += 2;
  cpu.pc = addr;
}

// work/avr-bridge/node_modules/avr8js/dist/esm/cpu/cpu.js
var registerSpace = 256;
var MAX_INTERRUPTS = 128;
var CPU = class {
  constructor(progMem, sramBytes = 8192) {
    this.progMem = progMem;
    this.sramBytes = sramBytes;
    this.data = new Uint8Array(this.sramBytes + registerSpace);
    this.data16 = new Uint16Array(this.data.buffer);
    this.dataView = new DataView(this.data.buffer);
    this.progBytes = new Uint8Array(this.progMem.buffer);
    this.readHooks = [];
    this.writeHooks = [];
    this.pendingInterrupts = new Array(MAX_INTERRUPTS);
    this.nextClockEvent = null;
    this.clockEventPool = [];
    this.pc22Bits = this.progBytes.length > 131072;
    this.gpioPorts = /* @__PURE__ */ new Set();
    this.gpioByPort = [];
    this.onWatchdogReset = () => {
    };
    this.pc = 0;
    this.cycles = 0;
    this.nextInterrupt = -1;
    this.maxInterrupt = 0;
    this.reset();
  }
  reset() {
    this.SP = this.data.length - 1;
    this.pc = 0;
    this.pendingInterrupts.fill(null);
    this.nextInterrupt = -1;
    this.nextClockEvent = null;
  }
  readData(addr) {
    if (addr >= 32 && this.readHooks[addr]) {
      return this.readHooks[addr](addr);
    }
    return this.data[addr];
  }
  writeData(addr, value, mask = 255) {
    const hook = this.writeHooks[addr];
    if (hook) {
      if (hook(value, this.data[addr], addr, mask)) {
        return;
      }
    }
    this.data[addr] = value;
  }
  get SP() {
    return this.dataView.getUint16(93, true);
  }
  set SP(value) {
    this.dataView.setUint16(93, value, true);
  }
  get SREG() {
    return this.data[95];
  }
  get interruptsEnabled() {
    return this.SREG & 128 ? true : false;
  }
  setInterruptFlag(interrupt) {
    const { flagRegister, flagMask, enableRegister, enableMask } = interrupt;
    if (interrupt.inverseFlag) {
      this.data[flagRegister] &= ~flagMask;
    } else {
      this.data[flagRegister] |= flagMask;
    }
    if (this.data[enableRegister] & enableMask) {
      this.queueInterrupt(interrupt);
    }
  }
  updateInterruptEnable(interrupt, registerValue) {
    const { enableMask, flagRegister, flagMask, inverseFlag } = interrupt;
    if (registerValue & enableMask) {
      const bitSet = this.data[flagRegister] & flagMask;
      if (inverseFlag ? !bitSet : bitSet) {
        this.queueInterrupt(interrupt);
      }
    } else {
      this.clearInterrupt(interrupt, false);
    }
  }
  queueInterrupt(interrupt) {
    const { address } = interrupt;
    this.pendingInterrupts[address] = interrupt;
    if (this.nextInterrupt === -1 || this.nextInterrupt > address) {
      this.nextInterrupt = address;
    }
    if (address > this.maxInterrupt) {
      this.maxInterrupt = address;
    }
  }
  clearInterrupt({ address, flagRegister, flagMask }, clearFlag = true) {
    if (clearFlag) {
      this.data[flagRegister] &= ~flagMask;
    }
    const { pendingInterrupts, maxInterrupt } = this;
    if (!pendingInterrupts[address]) {
      return;
    }
    pendingInterrupts[address] = null;
    if (this.nextInterrupt === address) {
      this.nextInterrupt = -1;
      for (let i = address + 1; i <= maxInterrupt; i++) {
        if (pendingInterrupts[i]) {
          this.nextInterrupt = i;
          break;
        }
      }
    }
  }
  clearInterruptByFlag(interrupt, registerValue) {
    const { flagRegister, flagMask } = interrupt;
    if (registerValue & flagMask) {
      this.data[flagRegister] &= ~flagMask;
      this.clearInterrupt(interrupt);
    }
  }
  addClockEvent(callback, cycles) {
    const { clockEventPool } = this;
    cycles = this.cycles + Math.max(1, cycles);
    const maybeEntry = clockEventPool.pop();
    const entry = maybeEntry !== null && maybeEntry !== void 0 ? maybeEntry : { cycles, callback, next: null };
    entry.cycles = cycles;
    entry.callback = callback;
    let { nextClockEvent: clockEvent } = this;
    let lastItem = null;
    while (clockEvent && clockEvent.cycles < cycles) {
      lastItem = clockEvent;
      clockEvent = clockEvent.next;
    }
    if (lastItem) {
      lastItem.next = entry;
      entry.next = clockEvent;
    } else {
      this.nextClockEvent = entry;
      entry.next = clockEvent;
    }
    return callback;
  }
  updateClockEvent(callback, cycles) {
    if (this.clearClockEvent(callback)) {
      this.addClockEvent(callback, cycles);
      return true;
    }
    return false;
  }
  clearClockEvent(callback) {
    let { nextClockEvent: clockEvent } = this;
    if (!clockEvent) {
      return false;
    }
    const { clockEventPool } = this;
    let lastItem = null;
    while (clockEvent) {
      if (clockEvent.callback === callback) {
        if (lastItem) {
          lastItem.next = clockEvent.next;
        } else {
          this.nextClockEvent = clockEvent.next;
        }
        if (clockEventPool.length < 10) {
          clockEventPool.push(clockEvent);
        }
        return true;
      }
      lastItem = clockEvent;
      clockEvent = clockEvent.next;
    }
    return false;
  }
  tick() {
    const { nextClockEvent } = this;
    if (nextClockEvent && nextClockEvent.cycles <= this.cycles) {
      nextClockEvent.callback();
      this.nextClockEvent = nextClockEvent.next;
      if (this.clockEventPool.length < 10) {
        this.clockEventPool.push(nextClockEvent);
      }
    }
    const { nextInterrupt } = this;
    if (this.interruptsEnabled && nextInterrupt >= 0) {
      const interrupt = this.pendingInterrupts[nextInterrupt];
      avrInterrupt(this, interrupt.address);
      if (!interrupt.constant) {
        this.clearInterrupt(interrupt);
      }
    }
  }
};

// work/avr-bridge/node_modules/avr8js/dist/esm/cpu/instruction.js
function isTwoWordInstruction(opcode) {
  return (
    /* LDS */
    (opcode & 65039) === 36864 || /* STS */
    (opcode & 65039) === 37376 || /* CALL */
    (opcode & 65038) === 37902 || /* JMP */
    (opcode & 65038) === 37900
  );
}
function avrInstruction(cpu) {
  const opcode = cpu.progMem[cpu.pc];
  if ((opcode & 64512) === 7168) {
    const d = cpu.data[(opcode & 496) >> 4];
    const r = cpu.data[opcode & 15 | (opcode & 512) >> 5];
    const sum = d + r + (cpu.data[95] & 1);
    const R = sum & 255;
    cpu.data[(opcode & 496) >> 4] = R;
    let sreg = cpu.data[95] & 192;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= (R ^ r) & (d ^ R) & 128 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    sreg |= sum & 256 ? 1 : 0;
    sreg |= 1 & (d & r | r & ~R | ~R & d) ? 32 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 64512) === 3072) {
    const d = cpu.data[(opcode & 496) >> 4];
    const r = cpu.data[opcode & 15 | (opcode & 512) >> 5];
    const R = d + r & 255;
    cpu.data[(opcode & 496) >> 4] = R;
    let sreg = cpu.data[95] & 192;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= (R ^ r) & (R ^ d) & 128 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    sreg |= d + r & 256 ? 1 : 0;
    sreg |= 1 & (d & r | r & ~R | ~R & d) ? 32 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 65280) === 38400) {
    const addr = 2 * ((opcode & 48) >> 4) + 24;
    const value = cpu.dataView.getUint16(addr, true);
    const R = value + (opcode & 15 | (opcode & 192) >> 2) & 65535;
    cpu.dataView.setUint16(addr, R, true);
    let sreg = cpu.data[95] & 224;
    sreg |= R ? 0 : 2;
    sreg |= 32768 & R ? 4 : 0;
    sreg |= ~value & R & 32768 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    sreg |= ~R & value & 32768 ? 1 : 0;
    cpu.data[95] = sreg;
    cpu.cycles++;
  } else if ((opcode & 64512) === 8192) {
    const R = cpu.data[(opcode & 496) >> 4] & cpu.data[opcode & 15 | (opcode & 512) >> 5];
    cpu.data[(opcode & 496) >> 4] = R;
    let sreg = cpu.data[95] & 225;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 61440) === 28672) {
    const R = cpu.data[((opcode & 240) >> 4) + 16] & (opcode & 15 | (opcode & 3840) >> 4);
    cpu.data[((opcode & 240) >> 4) + 16] = R;
    let sreg = cpu.data[95] & 225;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 65039) === 37893) {
    const value = cpu.data[(opcode & 496) >> 4];
    const R = value >>> 1 | 128 & value;
    cpu.data[(opcode & 496) >> 4] = R;
    let sreg = cpu.data[95] & 224;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= value & 1;
    sreg |= sreg >> 2 & 1 ^ sreg & 1 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 65423) === 38024) {
    cpu.data[95] &= ~(1 << ((opcode & 112) >> 4));
  } else if ((opcode & 65032) === 63488) {
    const b = opcode & 7;
    const d = (opcode & 496) >> 4;
    cpu.data[d] = ~(1 << b) & cpu.data[d] | (cpu.data[95] >> 6 & 1) << b;
  } else if ((opcode & 64512) === 62464) {
    if (!(cpu.data[95] & 1 << (opcode & 7))) {
      cpu.pc = cpu.pc + (((opcode & 504) >> 3) - (opcode & 512 ? 64 : 0));
      cpu.cycles++;
    }
  } else if ((opcode & 64512) === 61440) {
    if (cpu.data[95] & 1 << (opcode & 7)) {
      cpu.pc = cpu.pc + (((opcode & 504) >> 3) - (opcode & 512 ? 64 : 0));
      cpu.cycles++;
    }
  } else if ((opcode & 65423) === 37896) {
    cpu.data[95] |= 1 << ((opcode & 112) >> 4);
  } else if ((opcode & 65032) === 64e3) {
    const d = cpu.data[(opcode & 496) >> 4];
    const b = opcode & 7;
    cpu.data[95] = cpu.data[95] & 191 | (d >> b & 1 ? 64 : 0);
  } else if ((opcode & 65038) === 37902) {
    const k = cpu.progMem[cpu.pc + 1] | (opcode & 1) << 16 | (opcode & 496) << 13;
    const ret = cpu.pc + 2;
    const sp = cpu.dataView.getUint16(93, true);
    const { pc22Bits } = cpu;
    cpu.data[sp] = 255 & ret;
    cpu.data[sp - 1] = ret >> 8 & 255;
    if (pc22Bits) {
      cpu.data[sp - 2] = ret >> 16 & 255;
    }
    cpu.dataView.setUint16(93, sp - (pc22Bits ? 3 : 2), true);
    cpu.pc = k - 1;
    cpu.cycles += pc22Bits ? 4 : 3;
  } else if ((opcode & 65280) === 38912) {
    const A = opcode & 248;
    const b = opcode & 7;
    const R = cpu.readData((A >> 3) + 32);
    const mask = 1 << b;
    cpu.writeData((A >> 3) + 32, R & ~mask, mask);
  } else if ((opcode & 65039) === 37888) {
    const d = (opcode & 496) >> 4;
    const R = 255 - cpu.data[d];
    cpu.data[d] = R;
    let sreg = cpu.data[95] & 225 | 1;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 64512) === 5120) {
    const val1 = cpu.data[(opcode & 496) >> 4];
    const val2 = cpu.data[opcode & 15 | (opcode & 512) >> 5];
    const R = val1 - val2;
    let sreg = cpu.data[95] & 192;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= 0 !== ((val1 ^ val2) & (val1 ^ R) & 128) ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    sreg |= val2 > val1 ? 1 : 0;
    sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 64512) === 1024) {
    const arg1 = cpu.data[(opcode & 496) >> 4];
    const arg2 = cpu.data[opcode & 15 | (opcode & 512) >> 5];
    let sreg = cpu.data[95];
    const r = arg1 - arg2 - (sreg & 1);
    sreg = sreg & 192 | (!r && sreg >> 1 & 1 ? 2 : 0) | (arg2 + (sreg & 1) > arg1 ? 1 : 0);
    sreg |= 128 & r ? 4 : 0;
    sreg |= (arg1 ^ arg2) & (arg1 ^ r) & 128 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    sreg |= 1 & (~arg1 & arg2 | arg2 & r | r & ~arg1) ? 32 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 61440) === 12288) {
    const arg1 = cpu.data[((opcode & 240) >> 4) + 16];
    const arg2 = opcode & 15 | (opcode & 3840) >> 4;
    const r = arg1 - arg2;
    let sreg = cpu.data[95] & 192;
    sreg |= r ? 0 : 2;
    sreg |= 128 & r ? 4 : 0;
    sreg |= (arg1 ^ arg2) & (arg1 ^ r) & 128 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    sreg |= arg2 > arg1 ? 1 : 0;
    sreg |= 1 & (~arg1 & arg2 | arg2 & r | r & ~arg1) ? 32 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 64512) === 4096) {
    if (cpu.data[(opcode & 496) >> 4] === cpu.data[opcode & 15 | (opcode & 512) >> 5]) {
      const nextOpcode = cpu.progMem[cpu.pc + 1];
      const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
      cpu.pc += skipSize;
      cpu.cycles += skipSize;
    }
  } else if ((opcode & 65039) === 37898) {
    const value = cpu.data[(opcode & 496) >> 4];
    const R = value - 1;
    cpu.data[(opcode & 496) >> 4] = R;
    let sreg = cpu.data[95] & 225;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= 128 === value ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    cpu.data[95] = sreg;
  } else if (opcode === 38169) {
    const retAddr = cpu.pc + 1;
    const sp = cpu.dataView.getUint16(93, true);
    const eind = cpu.data[92];
    cpu.data[sp] = retAddr & 255;
    cpu.data[sp - 1] = retAddr >> 8 & 255;
    cpu.data[sp - 2] = retAddr >> 16 & 255;
    cpu.dataView.setUint16(93, sp - 3, true);
    cpu.pc = (eind << 16 | cpu.dataView.getUint16(30, true)) - 1;
    cpu.cycles += 3;
  } else if (opcode === 37913) {
    const eind = cpu.data[92];
    cpu.pc = (eind << 16 | cpu.dataView.getUint16(30, true)) - 1;
    cpu.cycles++;
  } else if (opcode === 38360) {
    const rampz = cpu.data[91];
    cpu.data[0] = cpu.progBytes[rampz << 16 | cpu.dataView.getUint16(30, true)];
    cpu.cycles += 2;
  } else if ((opcode & 65039) === 36870) {
    const rampz = cpu.data[91];
    cpu.data[(opcode & 496) >> 4] = cpu.progBytes[rampz << 16 | cpu.dataView.getUint16(30, true)];
    cpu.cycles += 2;
  } else if ((opcode & 65039) === 36871) {
    const rampz = cpu.data[91];
    const i = cpu.dataView.getUint16(30, true);
    cpu.data[(opcode & 496) >> 4] = cpu.progBytes[rampz << 16 | i];
    cpu.dataView.setUint16(30, i + 1, true);
    if (i === 65535) {
      cpu.data[91] = (rampz + 1) % (cpu.progBytes.length >> 16);
    }
    cpu.cycles += 2;
  } else if ((opcode & 64512) === 9216) {
    const R = cpu.data[(opcode & 496) >> 4] ^ cpu.data[opcode & 15 | (opcode & 512) >> 5];
    cpu.data[(opcode & 496) >> 4] = R;
    let sreg = cpu.data[95] & 225;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 65416) === 776) {
    const v1 = cpu.data[((opcode & 112) >> 4) + 16];
    const v2 = cpu.data[(opcode & 7) + 16];
    const R = v1 * v2 << 1;
    cpu.dataView.setUint16(0, R, true);
    cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (v1 * v2 & 32768 ? 1 : 0);
    cpu.cycles++;
  } else if ((opcode & 65416) === 896) {
    const v1 = cpu.dataView.getInt8(((opcode & 112) >> 4) + 16);
    const v2 = cpu.dataView.getInt8((opcode & 7) + 16);
    const R = v1 * v2 << 1;
    cpu.dataView.setInt16(0, R, true);
    cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (v1 * v2 & 32768 ? 1 : 0);
    cpu.cycles++;
  } else if ((opcode & 65416) === 904) {
    const v1 = cpu.dataView.getInt8(((opcode & 112) >> 4) + 16);
    const v2 = cpu.data[(opcode & 7) + 16];
    const R = v1 * v2 << 1;
    cpu.dataView.setInt16(0, R, true);
    cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 2 : 0) | (v1 * v2 & 32768 ? 1 : 0);
    cpu.cycles++;
  } else if (opcode === 38153) {
    const retAddr = cpu.pc + 1;
    const sp = cpu.dataView.getUint16(93, true);
    const { pc22Bits } = cpu;
    cpu.data[sp] = retAddr & 255;
    cpu.data[sp - 1] = retAddr >> 8 & 255;
    if (pc22Bits) {
      cpu.data[sp - 2] = retAddr >> 16 & 255;
    }
    cpu.dataView.setUint16(93, sp - (pc22Bits ? 3 : 2), true);
    cpu.pc = cpu.dataView.getUint16(30, true) - 1;
    cpu.cycles += pc22Bits ? 3 : 2;
  } else if (opcode === 37897) {
    cpu.pc = cpu.dataView.getUint16(30, true) - 1;
    cpu.cycles++;
  } else if ((opcode & 63488) === 45056) {
    const i = cpu.readData((opcode & 15 | (opcode & 1536) >> 5) + 32);
    cpu.data[(opcode & 496) >> 4] = i;
  } else if ((opcode & 65039) === 37891) {
    const d = cpu.data[(opcode & 496) >> 4];
    const r = d + 1 & 255;
    cpu.data[(opcode & 496) >> 4] = r;
    let sreg = cpu.data[95] & 225;
    sreg |= r ? 0 : 2;
    sreg |= 128 & r ? 4 : 0;
    sreg |= 127 === d ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 65038) === 37900) {
    cpu.pc = (cpu.progMem[cpu.pc + 1] | (opcode & 1) << 16 | (opcode & 496) << 13) - 1;
    cpu.cycles += 2;
  } else if ((opcode & 65039) === 37382) {
    const r = (opcode & 496) >> 4;
    const clear = cpu.data[r];
    const value = cpu.readData(cpu.dataView.getUint16(30, true));
    cpu.writeData(cpu.dataView.getUint16(30, true), value & 255 - clear);
    cpu.data[r] = value;
  } else if ((opcode & 65039) === 37381) {
    const r = (opcode & 496) >> 4;
    const set = cpu.data[r];
    const value = cpu.readData(cpu.dataView.getUint16(30, true));
    cpu.writeData(cpu.dataView.getUint16(30, true), value | set);
    cpu.data[r] = value;
  } else if ((opcode & 65039) === 37383) {
    const r = cpu.data[(opcode & 496) >> 4];
    const R = cpu.readData(cpu.dataView.getUint16(30, true));
    cpu.writeData(cpu.dataView.getUint16(30, true), r ^ R);
    cpu.data[(opcode & 496) >> 4] = R;
  } else if ((opcode & 61440) === 57344) {
    cpu.data[((opcode & 240) >> 4) + 16] = opcode & 15 | (opcode & 3840) >> 4;
  } else if ((opcode & 65039) === 36864) {
    cpu.cycles++;
    const value = cpu.readData(cpu.progMem[cpu.pc + 1]);
    cpu.data[(opcode & 496) >> 4] = value;
    cpu.pc++;
  } else if ((opcode & 65039) === 36876) {
    cpu.cycles++;
    cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(26, true));
  } else if ((opcode & 65039) === 36877) {
    const x = cpu.dataView.getUint16(26, true);
    cpu.cycles++;
    cpu.data[(opcode & 496) >> 4] = cpu.readData(x);
    cpu.dataView.setUint16(26, x + 1, true);
  } else if ((opcode & 65039) === 36878) {
    const x = cpu.dataView.getUint16(26, true) - 1;
    cpu.dataView.setUint16(26, x, true);
    cpu.cycles++;
    cpu.data[(opcode & 496) >> 4] = cpu.readData(x);
  } else if ((opcode & 65039) === 32776) {
    cpu.cycles++;
    cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(28, true));
  } else if ((opcode & 65039) === 36873) {
    const y = cpu.dataView.getUint16(28, true);
    cpu.cycles++;
    cpu.data[(opcode & 496) >> 4] = cpu.readData(y);
    cpu.dataView.setUint16(28, y + 1, true);
  } else if ((opcode & 65039) === 36874) {
    const y = cpu.dataView.getUint16(28, true) - 1;
    cpu.dataView.setUint16(28, y, true);
    cpu.cycles++;
    cpu.data[(opcode & 496) >> 4] = cpu.readData(y);
  } else if ((opcode & 53768) === 32776 && opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8) {
    cpu.cycles++;
    cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(28, true) + (opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8));
  } else if ((opcode & 65039) === 32768) {
    cpu.cycles++;
    cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(30, true));
  } else if ((opcode & 65039) === 36865) {
    const z = cpu.dataView.getUint16(30, true);
    cpu.cycles++;
    cpu.data[(opcode & 496) >> 4] = cpu.readData(z);
    cpu.dataView.setUint16(30, z + 1, true);
  } else if ((opcode & 65039) === 36866) {
    const z = cpu.dataView.getUint16(30, true) - 1;
    cpu.dataView.setUint16(30, z, true);
    cpu.cycles++;
    cpu.data[(opcode & 496) >> 4] = cpu.readData(z);
  } else if ((opcode & 53768) === 32768 && opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8) {
    cpu.cycles++;
    cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(30, true) + (opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8));
  } else if (opcode === 38344) {
    cpu.data[0] = cpu.progBytes[cpu.dataView.getUint16(30, true)];
    cpu.cycles += 2;
  } else if ((opcode & 65039) === 36868) {
    cpu.data[(opcode & 496) >> 4] = cpu.progBytes[cpu.dataView.getUint16(30, true)];
    cpu.cycles += 2;
  } else if ((opcode & 65039) === 36869) {
    const i = cpu.dataView.getUint16(30, true);
    cpu.data[(opcode & 496) >> 4] = cpu.progBytes[i];
    cpu.dataView.setUint16(30, i + 1, true);
    cpu.cycles += 2;
  } else if ((opcode & 65039) === 37894) {
    const value = cpu.data[(opcode & 496) >> 4];
    const R = value >>> 1;
    cpu.data[(opcode & 496) >> 4] = R;
    let sreg = cpu.data[95] & 224;
    sreg |= R ? 0 : 2;
    sreg |= value & 1;
    sreg |= sreg >> 2 & 1 ^ sreg & 1 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 64512) === 11264) {
    cpu.data[(opcode & 496) >> 4] = cpu.data[opcode & 15 | (opcode & 512) >> 5];
  } else if ((opcode & 65280) === 256) {
    const r2 = 2 * (opcode & 15);
    const d2 = 2 * ((opcode & 240) >> 4);
    cpu.data[d2] = cpu.data[r2];
    cpu.data[d2 + 1] = cpu.data[r2 + 1];
  } else if ((opcode & 64512) === 39936) {
    const R = cpu.data[(opcode & 496) >> 4] * cpu.data[opcode & 15 | (opcode & 512) >> 5];
    cpu.dataView.setUint16(0, R, true);
    cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (32768 & R ? 1 : 0);
    cpu.cycles++;
  } else if ((opcode & 65280) === 512) {
    const R = cpu.dataView.getInt8(((opcode & 240) >> 4) + 16) * cpu.dataView.getInt8((opcode & 15) + 16);
    cpu.dataView.setInt16(0, R, true);
    cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (32768 & R ? 1 : 0);
    cpu.cycles++;
  } else if ((opcode & 65416) === 768) {
    const R = cpu.dataView.getInt8(((opcode & 112) >> 4) + 16) * cpu.data[(opcode & 7) + 16];
    cpu.dataView.setInt16(0, R, true);
    cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (32768 & R ? 1 : 0);
    cpu.cycles++;
  } else if ((opcode & 65039) === 37889) {
    const d = (opcode & 496) >> 4;
    const value = cpu.data[d];
    const R = 0 - value;
    cpu.data[d] = R;
    let sreg = cpu.data[95] & 192;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= 128 === R ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    sreg |= R ? 1 : 0;
    sreg |= 1 & (R | value) ? 32 : 0;
    cpu.data[95] = sreg;
  } else if (opcode === 0) {
  } else if ((opcode & 64512) === 10240) {
    const R = cpu.data[(opcode & 496) >> 4] | cpu.data[opcode & 15 | (opcode & 512) >> 5];
    cpu.data[(opcode & 496) >> 4] = R;
    let sreg = cpu.data[95] & 225;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 61440) === 24576) {
    const R = cpu.data[((opcode & 240) >> 4) + 16] | (opcode & 15 | (opcode & 3840) >> 4);
    cpu.data[((opcode & 240) >> 4) + 16] = R;
    let sreg = cpu.data[95] & 225;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 63488) === 47104) {
    cpu.writeData((opcode & 15 | (opcode & 1536) >> 5) + 32, cpu.data[(opcode & 496) >> 4]);
  } else if ((opcode & 65039) === 36879) {
    const value = cpu.dataView.getUint16(93, true) + 1;
    cpu.dataView.setUint16(93, value, true);
    cpu.data[(opcode & 496) >> 4] = cpu.data[value];
    cpu.cycles++;
  } else if ((opcode & 65039) === 37391) {
    const value = cpu.dataView.getUint16(93, true);
    cpu.data[value] = cpu.data[(opcode & 496) >> 4];
    cpu.dataView.setUint16(93, value - 1, true);
    cpu.cycles++;
  } else if ((opcode & 61440) === 53248) {
    const k = (opcode & 2047) - (opcode & 2048 ? 2048 : 0);
    const retAddr = cpu.pc + 1;
    const sp = cpu.dataView.getUint16(93, true);
    const { pc22Bits } = cpu;
    cpu.data[sp] = 255 & retAddr;
    cpu.data[sp - 1] = retAddr >> 8 & 255;
    if (pc22Bits) {
      cpu.data[sp - 2] = retAddr >> 16 & 255;
    }
    cpu.dataView.setUint16(93, sp - (pc22Bits ? 3 : 2), true);
    cpu.pc += k;
    cpu.cycles += pc22Bits ? 3 : 2;
  } else if (opcode === 38152) {
    const { pc22Bits } = cpu;
    const i = cpu.dataView.getUint16(93, true) + (pc22Bits ? 3 : 2);
    cpu.dataView.setUint16(93, i, true);
    cpu.pc = (cpu.data[i - 1] << 8) + cpu.data[i] - 1;
    if (pc22Bits) {
      cpu.pc |= cpu.data[i - 2] << 16;
    }
    cpu.cycles += pc22Bits ? 4 : 3;
  } else if (opcode === 38168) {
    const { pc22Bits } = cpu;
    const i = cpu.dataView.getUint16(93, true) + (pc22Bits ? 3 : 2);
    cpu.dataView.setUint16(93, i, true);
    cpu.pc = (cpu.data[i - 1] << 8) + cpu.data[i] - 1;
    if (pc22Bits) {
      cpu.pc |= cpu.data[i - 2] << 16;
    }
    cpu.cycles += pc22Bits ? 4 : 3;
    cpu.data[95] |= 128;
  } else if ((opcode & 61440) === 49152) {
    cpu.pc = cpu.pc + ((opcode & 2047) - (opcode & 2048 ? 2048 : 0));
    cpu.cycles++;
  } else if ((opcode & 65039) === 37895) {
    const d = cpu.data[(opcode & 496) >> 4];
    const r = d >>> 1 | (cpu.data[95] & 1) << 7;
    cpu.data[(opcode & 496) >> 4] = r;
    let sreg = cpu.data[95] & 224;
    sreg |= r ? 0 : 2;
    sreg |= 128 & r ? 4 : 0;
    sreg |= 1 & d ? 1 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg & 1 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 64512) === 2048) {
    const val1 = cpu.data[(opcode & 496) >> 4];
    const val2 = cpu.data[opcode & 15 | (opcode & 512) >> 5];
    let sreg = cpu.data[95];
    const R = val1 - val2 - (sreg & 1);
    cpu.data[(opcode & 496) >> 4] = R;
    sreg = sreg & 192 | (!R && sreg >> 1 & 1 ? 2 : 0) | (val2 + (sreg & 1) > val1 ? 1 : 0);
    sreg |= 128 & R ? 4 : 0;
    sreg |= (val1 ^ val2) & (val1 ^ R) & 128 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 61440) === 16384) {
    const val1 = cpu.data[((opcode & 240) >> 4) + 16];
    const val2 = opcode & 15 | (opcode & 3840) >> 4;
    let sreg = cpu.data[95];
    const R = val1 - val2 - (sreg & 1);
    cpu.data[((opcode & 240) >> 4) + 16] = R;
    sreg = sreg & 192 | (!R && sreg >> 1 & 1 ? 2 : 0) | (val2 + (sreg & 1) > val1 ? 1 : 0);
    sreg |= 128 & R ? 4 : 0;
    sreg |= (val1 ^ val2) & (val1 ^ R) & 128 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 65280) === 39424) {
    const target = ((opcode & 248) >> 3) + 32;
    const mask = 1 << (opcode & 7);
    cpu.writeData(target, cpu.readData(target) | mask, mask);
    cpu.cycles++;
  } else if ((opcode & 65280) === 39168) {
    const value = cpu.readData(((opcode & 248) >> 3) + 32);
    if (!(value & 1 << (opcode & 7))) {
      const nextOpcode = cpu.progMem[cpu.pc + 1];
      const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
      cpu.cycles += skipSize;
      cpu.pc += skipSize;
    }
  } else if ((opcode & 65280) === 39680) {
    const value = cpu.readData(((opcode & 248) >> 3) + 32);
    if (value & 1 << (opcode & 7)) {
      const nextOpcode = cpu.progMem[cpu.pc + 1];
      const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
      cpu.cycles += skipSize;
      cpu.pc += skipSize;
    }
  } else if ((opcode & 65280) === 38656) {
    const i = 2 * ((opcode & 48) >> 4) + 24;
    const a = cpu.dataView.getUint16(i, true);
    const l = opcode & 15 | (opcode & 192) >> 2;
    const R = a - l;
    cpu.dataView.setUint16(i, R, true);
    let sreg = cpu.data[95] & 192;
    sreg |= R ? 0 : 2;
    sreg |= 32768 & R ? 4 : 0;
    sreg |= a & ~R & 32768 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    sreg |= l > a ? 1 : 0;
    sreg |= 1 & (~a & l | l & R | R & ~a) ? 32 : 0;
    cpu.data[95] = sreg;
    cpu.cycles++;
  } else if ((opcode & 65032) === 64512) {
    if (!(cpu.data[(opcode & 496) >> 4] & 1 << (opcode & 7))) {
      const nextOpcode = cpu.progMem[cpu.pc + 1];
      const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
      cpu.cycles += skipSize;
      cpu.pc += skipSize;
    }
  } else if ((opcode & 65032) === 65024) {
    if (cpu.data[(opcode & 496) >> 4] & 1 << (opcode & 7)) {
      const nextOpcode = cpu.progMem[cpu.pc + 1];
      const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
      cpu.cycles += skipSize;
      cpu.pc += skipSize;
    }
  } else if (opcode === 38280) {
  } else if (opcode === 38376) {
  } else if (opcode === 38392) {
  } else if ((opcode & 65039) === 37376) {
    const value = cpu.data[(opcode & 496) >> 4];
    const addr = cpu.progMem[cpu.pc + 1];
    cpu.writeData(addr, value);
    cpu.pc++;
    cpu.cycles++;
  } else if ((opcode & 65039) === 37388) {
    cpu.writeData(cpu.dataView.getUint16(26, true), cpu.data[(opcode & 496) >> 4]);
    cpu.cycles++;
  } else if ((opcode & 65039) === 37389) {
    const x = cpu.dataView.getUint16(26, true);
    cpu.writeData(x, cpu.data[(opcode & 496) >> 4]);
    cpu.dataView.setUint16(26, x + 1, true);
    cpu.cycles++;
  } else if ((opcode & 65039) === 37390) {
    const i = cpu.data[(opcode & 496) >> 4];
    const x = cpu.dataView.getUint16(26, true) - 1;
    cpu.dataView.setUint16(26, x, true);
    cpu.writeData(x, i);
    cpu.cycles++;
  } else if ((opcode & 65039) === 33288) {
    cpu.writeData(cpu.dataView.getUint16(28, true), cpu.data[(opcode & 496) >> 4]);
    cpu.cycles++;
  } else if ((opcode & 65039) === 37385) {
    const i = cpu.data[(opcode & 496) >> 4];
    const y = cpu.dataView.getUint16(28, true);
    cpu.writeData(y, i);
    cpu.dataView.setUint16(28, y + 1, true);
    cpu.cycles++;
  } else if ((opcode & 65039) === 37386) {
    const i = cpu.data[(opcode & 496) >> 4];
    const y = cpu.dataView.getUint16(28, true) - 1;
    cpu.dataView.setUint16(28, y, true);
    cpu.writeData(y, i);
    cpu.cycles++;
  } else if ((opcode & 53768) === 33288 && opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8) {
    cpu.writeData(cpu.dataView.getUint16(28, true) + (opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8), cpu.data[(opcode & 496) >> 4]);
    cpu.cycles++;
  } else if ((opcode & 65039) === 33280) {
    cpu.writeData(cpu.dataView.getUint16(30, true), cpu.data[(opcode & 496) >> 4]);
    cpu.cycles++;
  } else if ((opcode & 65039) === 37377) {
    const z = cpu.dataView.getUint16(30, true);
    cpu.writeData(z, cpu.data[(opcode & 496) >> 4]);
    cpu.dataView.setUint16(30, z + 1, true);
    cpu.cycles++;
  } else if ((opcode & 65039) === 37378) {
    const i = cpu.data[(opcode & 496) >> 4];
    const z = cpu.dataView.getUint16(30, true) - 1;
    cpu.dataView.setUint16(30, z, true);
    cpu.writeData(z, i);
    cpu.cycles++;
  } else if ((opcode & 53768) === 33280 && opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8) {
    cpu.writeData(cpu.dataView.getUint16(30, true) + (opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8), cpu.data[(opcode & 496) >> 4]);
    cpu.cycles++;
  } else if ((opcode & 64512) === 6144) {
    const val1 = cpu.data[(opcode & 496) >> 4];
    const val2 = cpu.data[opcode & 15 | (opcode & 512) >> 5];
    const R = val1 - val2;
    cpu.data[(opcode & 496) >> 4] = R;
    let sreg = cpu.data[95] & 192;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= (val1 ^ val2) & (val1 ^ R) & 128 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    sreg |= val2 > val1 ? 1 : 0;
    sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 61440) === 20480) {
    const val1 = cpu.data[((opcode & 240) >> 4) + 16];
    const val2 = opcode & 15 | (opcode & 3840) >> 4;
    const R = val1 - val2;
    cpu.data[((opcode & 240) >> 4) + 16] = R;
    let sreg = cpu.data[95] & 192;
    sreg |= R ? 0 : 2;
    sreg |= 128 & R ? 4 : 0;
    sreg |= (val1 ^ val2) & (val1 ^ R) & 128 ? 8 : 0;
    sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
    sreg |= val2 > val1 ? 1 : 0;
    sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
    cpu.data[95] = sreg;
  } else if ((opcode & 65039) === 37890) {
    const d = (opcode & 496) >> 4;
    const i = cpu.data[d];
    cpu.data[d] = (15 & i) << 4 | (240 & i) >>> 4;
  } else if (opcode === 38312) {
    cpu.onWatchdogReset();
  } else if ((opcode & 65039) === 37380) {
    const r = (opcode & 496) >> 4;
    const val1 = cpu.data[r];
    const val2 = cpu.data[cpu.dataView.getUint16(30, true)];
    cpu.data[cpu.dataView.getUint16(30, true)] = val1;
    cpu.data[r] = val2;
  }
  cpu.pc = (cpu.pc + 1) % cpu.progMem.length;
  cpu.cycles++;
}

// work/avr-bridge/node_modules/avr8js/dist/esm/peripherals/adc.js
var ADCReference;
(function(ADCReference2) {
  ADCReference2[ADCReference2["AVCC"] = 0] = "AVCC";
  ADCReference2[ADCReference2["AREF"] = 1] = "AREF";
  ADCReference2[ADCReference2["Internal1V1"] = 2] = "Internal1V1";
  ADCReference2[ADCReference2["Internal2V56"] = 3] = "Internal2V56";
  ADCReference2[ADCReference2["Reserved"] = 4] = "Reserved";
})(ADCReference || (ADCReference = {}));
var ADCMuxInputType;
(function(ADCMuxInputType2) {
  ADCMuxInputType2[ADCMuxInputType2["SingleEnded"] = 0] = "SingleEnded";
  ADCMuxInputType2[ADCMuxInputType2["Differential"] = 1] = "Differential";
  ADCMuxInputType2[ADCMuxInputType2["Constant"] = 2] = "Constant";
  ADCMuxInputType2[ADCMuxInputType2["Temperature"] = 3] = "Temperature";
})(ADCMuxInputType || (ADCMuxInputType = {}));
var atmega328Channels = {
  0: { type: ADCMuxInputType.SingleEnded, channel: 0 },
  1: { type: ADCMuxInputType.SingleEnded, channel: 1 },
  2: { type: ADCMuxInputType.SingleEnded, channel: 2 },
  3: { type: ADCMuxInputType.SingleEnded, channel: 3 },
  4: { type: ADCMuxInputType.SingleEnded, channel: 4 },
  5: { type: ADCMuxInputType.SingleEnded, channel: 5 },
  6: { type: ADCMuxInputType.SingleEnded, channel: 6 },
  7: { type: ADCMuxInputType.SingleEnded, channel: 7 },
  8: { type: ADCMuxInputType.Temperature },
  14: { type: ADCMuxInputType.Constant, voltage: 1.1 },
  15: { type: ADCMuxInputType.Constant, voltage: 0 }
};
var fallbackMuxInput = {
  type: ADCMuxInputType.Constant,
  voltage: 0
};
var adcConfig = {
  ADMUX: 124,
  ADCSRA: 122,
  ADCSRB: 123,
  ADCL: 120,
  ADCH: 121,
  DIDR0: 126,
  adcInterrupt: 42,
  numChannels: 8,
  muxInputMask: 15,
  muxChannels: atmega328Channels,
  adcReferences: [
    ADCReference.AREF,
    ADCReference.AVCC,
    ADCReference.Reserved,
    ADCReference.Internal1V1
  ]
};
var ADPS_MASK = 7;
var ADIE = 8;
var ADIF = 16;
var ADSC = 64;
var ADEN = 128;
var MUX_MASK = 31;
var ADLAR = 32;
var MUX5 = 8;
var REFS2 = 8;
var REFS_MASK = 3;
var REFS_SHIFT = 6;
var AVRADC = class {
  constructor(cpu, config) {
    this.cpu = cpu;
    this.config = config;
    this.channelValues = new Array(this.config.numChannels);
    this.avcc = 5;
    this.aref = 5;
    this.onADCRead = (input) => {
      var _a;
      let voltage = 0;
      switch (input.type) {
        case ADCMuxInputType.Constant:
          voltage = input.voltage;
          break;
        case ADCMuxInputType.SingleEnded:
          voltage = (_a = this.channelValues[input.channel]) !== null && _a !== void 0 ? _a : 0;
          break;
        case ADCMuxInputType.Differential:
          voltage = input.gain * ((this.channelValues[input.positiveChannel] || 0) - (this.channelValues[input.negativeChannel] || 0));
          break;
        case ADCMuxInputType.Temperature:
          voltage = 0.378125;
          break;
      }
      const rawValue = voltage / this.referenceVoltage * 1024;
      const result = Math.min(Math.max(Math.floor(rawValue), 0), 1023);
      this.cpu.addClockEvent(() => this.completeADCRead(result), this.sampleCycles);
    };
    this.converting = false;
    this.conversionCycles = 25;
    this.ADC = {
      address: this.config.adcInterrupt,
      flagRegister: this.config.ADCSRA,
      flagMask: ADIF,
      enableRegister: this.config.ADCSRA,
      enableMask: ADIE
    };
    cpu.writeHooks[config.ADCSRA] = (value, oldValue) => {
      var _a;
      if (value & ADEN && !(oldValue && ADEN)) {
        this.conversionCycles = 25;
      }
      cpu.data[config.ADCSRA] = value;
      cpu.updateInterruptEnable(this.ADC, value);
      if (!this.converting && value & ADSC) {
        if (!(value & ADEN)) {
          this.cpu.addClockEvent(() => this.completeADCRead(0), this.sampleCycles);
          return true;
        }
        let channel = this.cpu.data[this.config.ADMUX] & MUX_MASK;
        if (cpu.data[config.ADCSRB] & MUX5) {
          channel |= 32;
        }
        channel &= config.muxInputMask;
        const muxInput = (_a = config.muxChannels[channel]) !== null && _a !== void 0 ? _a : fallbackMuxInput;
        this.converting = true;
        this.onADCRead(muxInput);
        return true;
      }
    };
  }
  completeADCRead(value) {
    const { ADCL, ADCH, ADMUX, ADCSRA } = this.config;
    this.converting = false;
    this.conversionCycles = 13;
    if (this.cpu.data[ADMUX] & ADLAR) {
      this.cpu.data[ADCL] = value << 6 & 255;
      this.cpu.data[ADCH] = value >> 2;
    } else {
      this.cpu.data[ADCL] = value & 255;
      this.cpu.data[ADCH] = value >> 8 & 3;
    }
    this.cpu.data[ADCSRA] &= ~ADSC;
    this.cpu.setInterruptFlag(this.ADC);
  }
  get prescaler() {
    const { ADCSRA } = this.config;
    const adcsra = this.cpu.data[ADCSRA];
    const adps = adcsra & ADPS_MASK;
    switch (adps) {
      case 0:
      case 1:
        return 2;
      case 2:
        return 4;
      case 3:
        return 8;
      case 4:
        return 16;
      case 5:
        return 32;
      case 6:
        return 64;
      case 7:
      default:
        return 128;
    }
  }
  get referenceVoltageType() {
    var _a;
    const { ADMUX, adcReferences } = this.config;
    let refs = this.cpu.data[ADMUX] >> REFS_SHIFT & REFS_MASK;
    if (adcReferences.length > 4 && this.cpu.data[ADMUX] & REFS2) {
      refs |= 4;
    }
    return (_a = adcReferences[refs]) !== null && _a !== void 0 ? _a : ADCReference.Reserved;
  }
  get referenceVoltage() {
    switch (this.referenceVoltageType) {
      case ADCReference.AVCC:
        return this.avcc;
      case ADCReference.AREF:
        return this.aref;
      case ADCReference.Internal1V1:
        return 1.1;
      case ADCReference.Internal2V56:
        return 2.56;
      default:
        return this.avcc;
    }
  }
  get sampleCycles() {
    return this.conversionCycles * this.prescaler;
  }
};

// work/avr-bridge/node_modules/avr8js/dist/esm/peripherals/eeprom.js
var EERE = 1 << 0;
var EEPE = 1 << 1;
var EEMPE = 1 << 2;
var EERIE = 1 << 3;
var EEPM0 = 1 << 4;
var EEPM1 = 1 << 5;
var EECR_WRITE_MASK = EEPE | EEMPE | EERIE | EEPM0 | EEPM1;

// work/avr-bridge/node_modules/avr8js/dist/esm/peripherals/gpio.js
var INT0 = {
  EICR: 105,
  EIMSK: 61,
  EIFR: 60,
  index: 0,
  iscOffset: 0,
  interrupt: 2
};
var INT1 = {
  EICR: 105,
  EIMSK: 61,
  EIFR: 60,
  index: 1,
  iscOffset: 2,
  interrupt: 4
};
var PCINT0 = {
  PCIE: 0,
  PCICR: 104,
  PCIFR: 59,
  PCMSK: 107,
  pinChangeInterrupt: 6,
  mask: 255,
  offset: 0
};
var PCINT2 = {
  PCIE: 2,
  PCICR: 104,
  PCIFR: 59,
  PCMSK: 109,
  pinChangeInterrupt: 10,
  mask: 255,
  offset: 0
};
var portBConfig = {
  PIN: 35,
  DDR: 36,
  PORT: 37,
  // Interrupt settings
  pinChange: PCINT0,
  externalInterrupts: []
};
var portDConfig = {
  PIN: 41,
  DDR: 42,
  PORT: 43,
  // Interrupt settings
  pinChange: PCINT2,
  externalInterrupts: [null, null, INT0, INT1]
};
var PinState;
(function(PinState2) {
  PinState2[PinState2["Low"] = 0] = "Low";
  PinState2[PinState2["High"] = 1] = "High";
  PinState2[PinState2["Input"] = 2] = "Input";
  PinState2[PinState2["InputPullUp"] = 3] = "InputPullUp";
})(PinState || (PinState = {}));
var PinOverrideMode;
(function(PinOverrideMode2) {
  PinOverrideMode2[PinOverrideMode2["None"] = 0] = "None";
  PinOverrideMode2[PinOverrideMode2["Enable"] = 1] = "Enable";
  PinOverrideMode2[PinOverrideMode2["Set"] = 2] = "Set";
  PinOverrideMode2[PinOverrideMode2["Clear"] = 3] = "Clear";
  PinOverrideMode2[PinOverrideMode2["Toggle"] = 4] = "Toggle";
})(PinOverrideMode || (PinOverrideMode = {}));
var InterruptMode;
(function(InterruptMode2) {
  InterruptMode2[InterruptMode2["LowLevel"] = 0] = "LowLevel";
  InterruptMode2[InterruptMode2["Change"] = 1] = "Change";
  InterruptMode2[InterruptMode2["FallingEdge"] = 2] = "FallingEdge";
  InterruptMode2[InterruptMode2["RisingEdge"] = 3] = "RisingEdge";
})(InterruptMode || (InterruptMode = {}));
var AVRIOPort = class {
  constructor(cpu, portConfig) {
    var _a, _b, _c, _d;
    this.cpu = cpu;
    this.portConfig = portConfig;
    this.externalClockListeners = [];
    this.listeners = [];
    this.pinValue = 0;
    this.overrideMask = 255;
    this.overrideValue = 0;
    this.lastValue = 0;
    this.lastDdr = 0;
    this.lastPin = 0;
    this.openCollector = 0;
    cpu.gpioPorts.add(this);
    cpu.gpioByPort[portConfig.PORT] = this;
    cpu.writeHooks[portConfig.DDR] = (value) => {
      const portValue = cpu.data[portConfig.PORT];
      cpu.data[portConfig.DDR] = value;
      this.writeGpio(portValue, value);
      this.updatePinRegister(value);
      return true;
    };
    cpu.writeHooks[portConfig.PORT] = (value) => {
      const ddrMask = cpu.data[portConfig.DDR];
      cpu.data[portConfig.PORT] = value;
      this.writeGpio(value, ddrMask);
      this.updatePinRegister(ddrMask);
      return true;
    };
    cpu.writeHooks[portConfig.PIN] = (value, oldValue, addr, mask) => {
      const oldPortValue = cpu.data[portConfig.PORT];
      const ddrMask = cpu.data[portConfig.DDR];
      const portValue = oldPortValue ^ value & mask;
      cpu.data[portConfig.PORT] = portValue;
      this.writeGpio(portValue, ddrMask);
      this.updatePinRegister(ddrMask);
      return true;
    };
    const { externalInterrupts } = portConfig;
    this.externalInts = externalInterrupts.map((externalConfig) => externalConfig ? {
      address: externalConfig.interrupt,
      flagRegister: externalConfig.EIFR,
      flagMask: 1 << externalConfig.index,
      enableRegister: externalConfig.EIMSK,
      enableMask: 1 << externalConfig.index
    } : null);
    const EICR = new Set(externalInterrupts.map((item) => item === null || item === void 0 ? void 0 : item.EICR));
    for (const EICRx of EICR) {
      this.attachInterruptHook(EICRx || 0);
    }
    const EIMSK = (_b = (_a = externalInterrupts.find((item) => item && item.EIMSK)) === null || _a === void 0 ? void 0 : _a.EIMSK) !== null && _b !== void 0 ? _b : 0;
    this.attachInterruptHook(EIMSK, "mask");
    const EIFR = (_d = (_c = externalInterrupts.find((item) => item && item.EIFR)) === null || _c === void 0 ? void 0 : _c.EIFR) !== null && _d !== void 0 ? _d : 0;
    this.attachInterruptHook(EIFR, "flag");
    const { pinChange } = portConfig;
    this.PCINT = pinChange ? {
      address: pinChange.pinChangeInterrupt,
      flagRegister: pinChange.PCIFR,
      flagMask: 1 << pinChange.PCIE,
      enableRegister: pinChange.PCICR,
      enableMask: 1 << pinChange.PCIE
    } : null;
    if (pinChange) {
      const { PCIFR, PCMSK } = pinChange;
      cpu.writeHooks[PCIFR] = (value) => {
        for (const gpio of this.cpu.gpioPorts) {
          const { PCINT } = gpio;
          if (PCINT) {
            cpu.clearInterruptByFlag(PCINT, value);
          }
        }
        return true;
      };
      cpu.writeHooks[PCMSK] = (value) => {
        cpu.data[PCMSK] = value;
        for (const gpio of this.cpu.gpioPorts) {
          const { PCINT } = gpio;
          if (PCINT) {
            cpu.updateInterruptEnable(PCINT, value);
          }
        }
        return true;
      };
    }
  }
  addListener(listener) {
    this.listeners.push(listener);
  }
  removeListener(listener) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  /**
   * Get the state of a given GPIO pin
   *
   * @param index Pin index to return from 0 to 7
   * @returns PinState.Low or PinState.High if the pin is set to output, PinState.Input if the pin is set
   *   to input, and PinState.InputPullUp if the pin is set to input and the internal pull-up resistor has
   *   been enabled.
   */
  pinState(index) {
    const ddr = this.cpu.data[this.portConfig.DDR];
    const port = this.cpu.data[this.portConfig.PORT];
    const bitMask = 1 << index;
    const openState = port & bitMask ? PinState.InputPullUp : PinState.Input;
    const highValue = this.openCollector & bitMask ? openState : PinState.High;
    if (ddr & bitMask) {
      return this.lastValue & bitMask ? highValue : PinState.Low;
    } else {
      return openState;
    }
  }
  /**
   * Sets the input value for the given pin. This is the value that
   * will be returned when reading from the PIN register.
   */
  setPin(index, value) {
    const bitMask = 1 << index;
    this.pinValue &= ~bitMask;
    if (value) {
      this.pinValue |= bitMask;
    }
    this.updatePinRegister(this.cpu.data[this.portConfig.DDR]);
  }
  /**
   * Internal method - do not call this directly!
   * Used by the timer compare output units to override GPIO pins.
   */
  timerOverridePin(pin, mode) {
    const { cpu, portConfig } = this;
    const pinMask = 1 << pin;
    if (mode === PinOverrideMode.None) {
      this.overrideMask |= pinMask;
      this.overrideValue &= ~pinMask;
    } else {
      this.overrideMask &= ~pinMask;
      switch (mode) {
        case PinOverrideMode.Enable:
          this.overrideValue &= ~pinMask;
          this.overrideValue |= cpu.data[portConfig.PORT] & pinMask;
          break;
        case PinOverrideMode.Set:
          this.overrideValue |= pinMask;
          break;
        case PinOverrideMode.Clear:
          this.overrideValue &= ~pinMask;
          break;
        case PinOverrideMode.Toggle:
          this.overrideValue ^= pinMask;
          break;
      }
    }
    const ddrMask = cpu.data[portConfig.DDR];
    this.writeGpio(cpu.data[portConfig.PORT], ddrMask);
    this.updatePinRegister(ddrMask);
  }
  updatePinRegister(ddr) {
    var _a, _b;
    const newPin = this.pinValue & ~ddr | this.lastValue & ddr;
    this.cpu.data[this.portConfig.PIN] = newPin;
    if (this.lastPin !== newPin) {
      for (let index = 0; index < 8; index++) {
        if ((newPin & 1 << index) !== (this.lastPin & 1 << index)) {
          const value = !!(newPin & 1 << index);
          this.toggleInterrupt(index, value);
          (_b = (_a = this.externalClockListeners)[index]) === null || _b === void 0 ? void 0 : _b.call(_a, value);
        }
      }
      this.lastPin = newPin;
    }
  }
  toggleInterrupt(pin, risingEdge) {
    const { cpu, portConfig, externalInts, PCINT } = this;
    const { externalInterrupts, pinChange } = portConfig;
    const externalConfig = externalInterrupts[pin];
    const external = externalInts[pin];
    if (external && externalConfig) {
      const { EIMSK, index, EICR, iscOffset } = externalConfig;
      if (cpu.data[EIMSK] & 1 << index) {
        const configuration = cpu.data[EICR] >> iscOffset & 3;
        let generateInterrupt = false;
        external.constant = false;
        switch (configuration) {
          case InterruptMode.LowLevel:
            generateInterrupt = !risingEdge;
            external.constant = true;
            break;
          case InterruptMode.Change:
            generateInterrupt = true;
            break;
          case InterruptMode.FallingEdge:
            generateInterrupt = !risingEdge;
            break;
          case InterruptMode.RisingEdge:
            generateInterrupt = risingEdge;
            break;
        }
        if (generateInterrupt) {
          cpu.setInterruptFlag(external);
        } else if (external.constant) {
          cpu.clearInterrupt(external, true);
        }
      }
    }
    if (pinChange && PCINT && pinChange.mask & 1 << pin) {
      const { PCMSK } = pinChange;
      if (cpu.data[PCMSK] & 1 << pin + pinChange.offset) {
        cpu.setInterruptFlag(PCINT);
      }
    }
  }
  attachInterruptHook(register, registerType = "other") {
    if (!register) {
      return;
    }
    const { cpu } = this;
    cpu.writeHooks[register] = (value) => {
      if (registerType !== "flag") {
        cpu.data[register] = value;
      }
      for (const gpio of cpu.gpioPorts) {
        for (const external of gpio.externalInts) {
          if (external && registerType === "mask") {
            cpu.updateInterruptEnable(external, value);
          }
          if (external && !external.constant && registerType === "flag") {
            cpu.clearInterruptByFlag(external, value);
          }
        }
        gpio.checkExternalInterrupts();
      }
      return true;
    };
  }
  checkExternalInterrupts() {
    const { cpu } = this;
    const { externalInterrupts } = this.portConfig;
    for (let pin = 0; pin < 8; pin++) {
      const external = externalInterrupts[pin];
      if (!external) {
        continue;
      }
      const pinValue = !!(this.lastPin & 1 << pin);
      const { EIFR, EIMSK, index, EICR, iscOffset, interrupt } = external;
      if (!(cpu.data[EIMSK] & 1 << index) || pinValue) {
        continue;
      }
      const configuration = cpu.data[EICR] >> iscOffset & 3;
      if (configuration === InterruptMode.LowLevel) {
        cpu.queueInterrupt({
          address: interrupt,
          flagRegister: EIFR,
          flagMask: 1 << index,
          enableRegister: EIMSK,
          enableMask: 1 << index,
          constant: true
        });
      }
    }
  }
  writeGpio(value, ddr) {
    const newValue = (value & this.overrideMask | this.overrideValue) & ddr | value & ~ddr;
    const prevValue = this.lastValue;
    if (newValue !== prevValue || ddr !== this.lastDdr) {
      this.lastValue = newValue;
      this.lastDdr = ddr;
      for (const listener of this.listeners) {
        listener(newValue, prevValue);
      }
    }
  }
};

// work/avr-bridge/node_modules/avr8js/dist/esm/peripherals/spi.js
var SPCR_SPR1 = 2;
var SPCR_SPR0 = 1;
var SPSR_SPR_MASK = SPCR_SPR1 | SPCR_SPR0;

// work/avr-bridge/node_modules/avr8js/dist/esm/peripherals/timer.js
var timer01Dividers = {
  0: 0,
  1: 1,
  2: 8,
  3: 64,
  4: 256,
  5: 1024,
  6: 0,
  // External clock - see ExternalClockMode
  7: 0
  // Ditto
};
var ExternalClockMode;
(function(ExternalClockMode2) {
  ExternalClockMode2[ExternalClockMode2["FallingEdge"] = 6] = "FallingEdge";
  ExternalClockMode2[ExternalClockMode2["RisingEdge"] = 7] = "RisingEdge";
})(ExternalClockMode || (ExternalClockMode = {}));
var defaultTimerBits = {
  // TIFR bits
  TOV: 1,
  OCFA: 2,
  OCFB: 4,
  OCFC: 0,
  // Unused
  // TIMSK bits
  TOIE: 1,
  OCIEA: 2,
  OCIEB: 4,
  OCIEC: 0
  // Unused
};
var timer0Config = Object.assign({ bits: 8, captureInterrupt: 0, compAInterrupt: 28, compBInterrupt: 30, compCInterrupt: 0, ovfInterrupt: 32, TIFR: 53, OCRA: 71, OCRB: 72, OCRC: 0, ICR: 0, TCNT: 70, TCCRA: 68, TCCRB: 69, TCCRC: 0, TIMSK: 110, dividers: timer01Dividers, compPortA: portDConfig.PORT, compPinA: 6, compPortB: portDConfig.PORT, compPinB: 5, compPortC: 0, compPinC: 0, externalClockPort: portDConfig.PORT, externalClockPin: 4 }, defaultTimerBits);
var timer1Config = Object.assign({ bits: 16, captureInterrupt: 20, compAInterrupt: 22, compBInterrupt: 24, compCInterrupt: 0, ovfInterrupt: 26, TIFR: 54, OCRA: 136, OCRB: 138, OCRC: 0, ICR: 134, TCNT: 132, TCCRA: 128, TCCRB: 129, TCCRC: 130, TIMSK: 111, dividers: timer01Dividers, compPortA: portBConfig.PORT, compPinA: 1, compPortB: portBConfig.PORT, compPinB: 2, compPortC: 0, compPinC: 0, externalClockPort: portDConfig.PORT, externalClockPin: 5 }, defaultTimerBits);
var timer2Config = Object.assign({ bits: 8, captureInterrupt: 0, compAInterrupt: 14, compBInterrupt: 16, compCInterrupt: 0, ovfInterrupt: 18, TIFR: 55, OCRA: 179, OCRB: 180, OCRC: 0, ICR: 0, TCNT: 178, TCCRA: 176, TCCRB: 177, TCCRC: 0, TIMSK: 112, dividers: {
  0: 0,
  1: 1,
  2: 8,
  3: 32,
  4: 64,
  5: 128,
  6: 256,
  7: 1024
}, compPortA: portBConfig.PORT, compPinA: 3, compPortB: portDConfig.PORT, compPinB: 3, compPortC: 0, compPinC: 0, externalClockPort: 0, externalClockPin: 0 }, defaultTimerBits);
var TimerMode;
(function(TimerMode2) {
  TimerMode2[TimerMode2["Normal"] = 0] = "Normal";
  TimerMode2[TimerMode2["PWMPhaseCorrect"] = 1] = "PWMPhaseCorrect";
  TimerMode2[TimerMode2["CTC"] = 2] = "CTC";
  TimerMode2[TimerMode2["FastPWM"] = 3] = "FastPWM";
  TimerMode2[TimerMode2["PWMPhaseFrequencyCorrect"] = 4] = "PWMPhaseFrequencyCorrect";
  TimerMode2[TimerMode2["Reserved"] = 5] = "Reserved";
})(TimerMode || (TimerMode = {}));
var TOVUpdateMode;
(function(TOVUpdateMode2) {
  TOVUpdateMode2[TOVUpdateMode2["Max"] = 0] = "Max";
  TOVUpdateMode2[TOVUpdateMode2["Top"] = 1] = "Top";
  TOVUpdateMode2[TOVUpdateMode2["Bottom"] = 2] = "Bottom";
})(TOVUpdateMode || (TOVUpdateMode = {}));
var OCRUpdateMode;
(function(OCRUpdateMode2) {
  OCRUpdateMode2[OCRUpdateMode2["Immediate"] = 0] = "Immediate";
  OCRUpdateMode2[OCRUpdateMode2["Top"] = 1] = "Top";
  OCRUpdateMode2[OCRUpdateMode2["Bottom"] = 2] = "Bottom";
})(OCRUpdateMode || (OCRUpdateMode = {}));
var TopOCRA = 1;
var TopICR = 2;
var OCToggle = 1;
var { Normal, PWMPhaseCorrect, CTC, FastPWM, Reserved, PWMPhaseFrequencyCorrect } = TimerMode;
var wgmModes8Bit = [
  /*0*/
  [Normal, 255, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
  /*1*/
  [PWMPhaseCorrect, 255, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
  /*2*/
  [CTC, TopOCRA, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
  /*3*/
  [FastPWM, 255, OCRUpdateMode.Bottom, TOVUpdateMode.Max, 0],
  /*4*/
  [Reserved, 255, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
  /*5*/
  [PWMPhaseCorrect, TopOCRA, OCRUpdateMode.Top, TOVUpdateMode.Bottom, OCToggle],
  /*6*/
  [Reserved, 255, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
  /*7*/
  [FastPWM, TopOCRA, OCRUpdateMode.Bottom, TOVUpdateMode.Top, OCToggle]
];
var wgmModes16Bit = [
  /*0 */
  [Normal, 65535, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
  /*1 */
  [PWMPhaseCorrect, 255, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
  /*2 */
  [PWMPhaseCorrect, 511, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
  /*3 */
  [PWMPhaseCorrect, 1023, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
  /*4 */
  [CTC, TopOCRA, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
  /*5 */
  [FastPWM, 255, OCRUpdateMode.Bottom, TOVUpdateMode.Top, 0],
  /*6 */
  [FastPWM, 511, OCRUpdateMode.Bottom, TOVUpdateMode.Top, 0],
  /*7 */
  [FastPWM, 1023, OCRUpdateMode.Bottom, TOVUpdateMode.Top, 0],
  /*8 */
  [PWMPhaseFrequencyCorrect, TopICR, OCRUpdateMode.Bottom, TOVUpdateMode.Bottom, 0],
  /*9 */
  [PWMPhaseFrequencyCorrect, TopOCRA, OCRUpdateMode.Bottom, TOVUpdateMode.Bottom, OCToggle],
  /*10*/
  [PWMPhaseCorrect, TopICR, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
  /*11*/
  [PWMPhaseCorrect, TopOCRA, OCRUpdateMode.Top, TOVUpdateMode.Bottom, OCToggle],
  /*12*/
  [CTC, TopICR, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
  /*13*/
  [Reserved, 65535, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
  /*14*/
  [FastPWM, TopICR, OCRUpdateMode.Bottom, TOVUpdateMode.Top, OCToggle],
  /*15*/
  [FastPWM, TopOCRA, OCRUpdateMode.Bottom, TOVUpdateMode.Top, OCToggle]
];
function compToOverride(comp) {
  switch (comp) {
    case 1:
      return PinOverrideMode.Toggle;
    case 2:
      return PinOverrideMode.Clear;
    case 3:
      return PinOverrideMode.Set;
    default:
      return PinOverrideMode.Enable;
  }
}
var FOCA = 1 << 7;
var FOCB = 1 << 6;
var FOCC = 1 << 5;
var AVRTimer = class {
  constructor(cpu, config) {
    this.cpu = cpu;
    this.config = config;
    this.MAX = this.config.bits === 16 ? 65535 : 255;
    this.lastCycle = 0;
    this.ocrA = 0;
    this.nextOcrA = 0;
    this.ocrB = 0;
    this.nextOcrB = 0;
    this.hasOCRC = this.config.OCRC > 0;
    this.ocrC = 0;
    this.nextOcrC = 0;
    this.ocrUpdateMode = OCRUpdateMode.Immediate;
    this.tovUpdateMode = TOVUpdateMode.Max;
    this.icr = 0;
    this.tcnt = 0;
    this.tcntNext = 0;
    this.tcntUpdated = false;
    this.updateDivider = false;
    this.countingUp = true;
    this.divider = 0;
    this.externalClockRisingEdge = false;
    this.highByteTemp = 0;
    this.OVF = {
      address: this.config.ovfInterrupt,
      flagRegister: this.config.TIFR,
      flagMask: this.config.TOV,
      enableRegister: this.config.TIMSK,
      enableMask: this.config.TOIE
    };
    this.OCFA = {
      address: this.config.compAInterrupt,
      flagRegister: this.config.TIFR,
      flagMask: this.config.OCFA,
      enableRegister: this.config.TIMSK,
      enableMask: this.config.OCIEA
    };
    this.OCFB = {
      address: this.config.compBInterrupt,
      flagRegister: this.config.TIFR,
      flagMask: this.config.OCFB,
      enableRegister: this.config.TIMSK,
      enableMask: this.config.OCIEB
    };
    this.OCFC = {
      address: this.config.compCInterrupt,
      flagRegister: this.config.TIFR,
      flagMask: this.config.OCFC,
      enableRegister: this.config.TIMSK,
      enableMask: this.config.OCIEC
    };
    this.count = (reschedule = true, external = false) => {
      const { divider, lastCycle, cpu: cpu2 } = this;
      const { cycles } = cpu2;
      const delta = cycles - lastCycle;
      if (divider && delta >= divider || external) {
        const counterDelta = external ? 1 : Math.floor(delta / divider);
        this.lastCycle += counterDelta * divider;
        const val = this.tcnt;
        const { timerMode, TOP } = this;
        const phasePwm = timerMode === PWMPhaseCorrect || timerMode === PWMPhaseFrequencyCorrect;
        const newVal = phasePwm ? this.phasePwmCount(val, counterDelta) : (val + counterDelta) % (TOP + 1);
        const overflow = val + counterDelta > TOP;
        if (!this.tcntUpdated) {
          this.tcnt = newVal;
          if (!phasePwm) {
            this.timerUpdated(newVal, val);
          }
        }
        if (!phasePwm) {
          if (timerMode === FastPWM && overflow) {
            const { compA, compB } = this;
            if (compA) {
              this.updateCompPin(compA, "A", true);
            }
            if (compB) {
              this.updateCompPin(compB, "B", true);
            }
          }
          if (this.ocrUpdateMode == OCRUpdateMode.Bottom && overflow) {
            this.ocrA = this.nextOcrA;
            this.ocrB = this.nextOcrB;
            this.ocrC = this.nextOcrC;
          }
          if (overflow && (this.tovUpdateMode == TOVUpdateMode.Top || TOP === this.MAX)) {
            cpu2.setInterruptFlag(this.OVF);
          }
        }
      }
      if (this.tcntUpdated) {
        this.tcnt = this.tcntNext;
        this.tcntUpdated = false;
        if (this.tcnt === 0 && this.ocrUpdateMode === OCRUpdateMode.Bottom || this.tcnt === this.TOP && this.ocrUpdateMode === OCRUpdateMode.Top) {
          this.ocrA = this.nextOcrA;
          this.ocrB = this.nextOcrB;
          this.ocrC = this.nextOcrC;
        }
      }
      if (this.updateDivider) {
        const { CS } = this;
        const { externalClockPin } = this.config;
        const newDivider = this.config.dividers[CS];
        this.lastCycle = newDivider ? this.cpu.cycles : 0;
        this.updateDivider = false;
        this.divider = newDivider;
        if (this.config.externalClockPort && !this.externalClockPort) {
          this.externalClockPort = this.cpu.gpioByPort[this.config.externalClockPort];
        }
        if (this.externalClockPort) {
          this.externalClockPort.externalClockListeners[externalClockPin] = null;
        }
        if (newDivider) {
          cpu2.addClockEvent(this.count, this.lastCycle + newDivider - cpu2.cycles);
        } else if (this.externalClockPort && (CS === ExternalClockMode.FallingEdge || CS === ExternalClockMode.RisingEdge)) {
          this.externalClockPort.externalClockListeners[externalClockPin] = this.externalClockCallback;
          this.externalClockRisingEdge = CS === ExternalClockMode.RisingEdge;
        }
        return;
      }
      if (reschedule && divider) {
        cpu2.addClockEvent(this.count, this.lastCycle + divider - cpu2.cycles);
      }
    };
    this.externalClockCallback = (value) => {
      if (value === this.externalClockRisingEdge) {
        this.count(false, true);
      }
    };
    this.updateWGMConfig();
    this.cpu.readHooks[config.TCNT] = (addr) => {
      this.count(false);
      if (this.config.bits === 16) {
        this.cpu.data[addr + 1] = this.tcnt >> 8;
      }
      return this.cpu.data[addr] = this.tcnt & 255;
    };
    this.cpu.writeHooks[config.TCNT] = (value) => {
      this.tcntNext = this.highByteTemp << 8 | value;
      this.countingUp = true;
      this.tcntUpdated = true;
      this.cpu.updateClockEvent(this.count, 0);
      if (this.divider) {
        this.timerUpdated(this.tcntNext, this.tcntNext);
      }
    };
    this.cpu.writeHooks[config.OCRA] = (value) => {
      this.nextOcrA = this.highByteTemp << 8 | value;
      if (this.ocrUpdateMode === OCRUpdateMode.Immediate) {
        this.ocrA = this.nextOcrA;
      }
    };
    this.cpu.writeHooks[config.OCRB] = (value) => {
      this.nextOcrB = this.highByteTemp << 8 | value;
      if (this.ocrUpdateMode === OCRUpdateMode.Immediate) {
        this.ocrB = this.nextOcrB;
      }
    };
    if (this.hasOCRC) {
      this.cpu.writeHooks[config.OCRC] = (value) => {
        this.nextOcrC = this.highByteTemp << 8 | value;
        if (this.ocrUpdateMode === OCRUpdateMode.Immediate) {
          this.ocrC = this.nextOcrC;
        }
      };
    }
    if (this.config.bits === 16) {
      this.cpu.writeHooks[config.ICR] = (value) => {
        this.icr = this.highByteTemp << 8 | value;
      };
      const updateTempRegister = (value) => {
        this.highByteTemp = value;
      };
      const updateOCRHighRegister = (value, old, addr) => {
        this.highByteTemp = value & this.ocrMask >> 8;
        cpu.data[addr] = this.highByteTemp;
        return true;
      };
      this.cpu.writeHooks[config.TCNT + 1] = updateTempRegister;
      this.cpu.writeHooks[config.OCRA + 1] = updateOCRHighRegister;
      this.cpu.writeHooks[config.OCRB + 1] = updateOCRHighRegister;
      if (this.hasOCRC) {
        this.cpu.writeHooks[config.OCRC + 1] = updateOCRHighRegister;
      }
      this.cpu.writeHooks[config.ICR + 1] = updateTempRegister;
    }
    cpu.writeHooks[config.TCCRA] = (value) => {
      this.cpu.data[config.TCCRA] = value;
      this.updateWGMConfig();
      return true;
    };
    cpu.writeHooks[config.TCCRB] = (value) => {
      if (!config.TCCRC) {
        this.checkForceCompare(value);
        value &= ~(FOCA | FOCB);
      }
      this.cpu.data[config.TCCRB] = value;
      this.updateDivider = true;
      this.cpu.clearClockEvent(this.count);
      this.cpu.addClockEvent(this.count, 0);
      this.updateWGMConfig();
      return true;
    };
    if (config.TCCRC) {
      cpu.writeHooks[config.TCCRC] = (value) => {
        this.checkForceCompare(value);
      };
    }
    cpu.writeHooks[config.TIFR] = (value) => {
      this.cpu.data[config.TIFR] = value;
      this.cpu.clearInterruptByFlag(this.OVF, value);
      this.cpu.clearInterruptByFlag(this.OCFA, value);
      this.cpu.clearInterruptByFlag(this.OCFB, value);
      return true;
    };
    cpu.writeHooks[config.TIMSK] = (value) => {
      this.cpu.updateInterruptEnable(this.OVF, value);
      this.cpu.updateInterruptEnable(this.OCFA, value);
      this.cpu.updateInterruptEnable(this.OCFB, value);
    };
  }
  reset() {
    this.divider = 0;
    this.lastCycle = 0;
    this.ocrA = 0;
    this.nextOcrA = 0;
    this.ocrB = 0;
    this.nextOcrB = 0;
    this.ocrC = 0;
    this.nextOcrC = 0;
    this.icr = 0;
    this.tcnt = 0;
    this.tcntNext = 0;
    this.tcntUpdated = false;
    this.countingUp = false;
    this.updateDivider = true;
  }
  get TCCRA() {
    return this.cpu.data[this.config.TCCRA];
  }
  get TCCRB() {
    return this.cpu.data[this.config.TCCRB];
  }
  get TIMSK() {
    return this.cpu.data[this.config.TIMSK];
  }
  get CS() {
    return this.TCCRB & 7;
  }
  get WGM() {
    const mask = this.config.bits === 16 ? 24 : 8;
    return (this.TCCRB & mask) >> 1 | this.TCCRA & 3;
  }
  get TOP() {
    switch (this.topValue) {
      case TopOCRA:
        return this.ocrA;
      case TopICR:
        return this.icr;
      default:
        return this.topValue;
    }
  }
  get ocrMask() {
    switch (this.topValue) {
      case TopOCRA:
      case TopICR:
        return 65535;
      default:
        return this.topValue;
    }
  }
  /** Expose the raw value of TCNT, for use by the unit tests */
  get debugTCNT() {
    return this.tcnt;
  }
  updateWGMConfig() {
    const { config, WGM } = this;
    const wgmModes = config.bits === 16 ? wgmModes16Bit : wgmModes8Bit;
    const TCCRA = this.cpu.data[config.TCCRA];
    const [timerMode, topValue, ocrUpdateMode, tovUpdateMode, flags] = wgmModes[WGM];
    this.timerMode = timerMode;
    this.topValue = topValue;
    this.ocrUpdateMode = ocrUpdateMode;
    this.tovUpdateMode = tovUpdateMode;
    const pwmMode = timerMode === FastPWM || timerMode === PWMPhaseCorrect || timerMode === PWMPhaseFrequencyCorrect;
    const prevCompA = this.compA;
    this.compA = TCCRA >> 6 & 3;
    if (this.compA === 1 && pwmMode && !(flags & OCToggle)) {
      this.compA = 0;
    }
    if (!!prevCompA !== !!this.compA) {
      this.updateCompA(this.compA ? PinOverrideMode.Enable : PinOverrideMode.None);
    }
    const prevCompB = this.compB;
    this.compB = TCCRA >> 4 & 3;
    if (this.compB === 1 && pwmMode) {
      this.compB = 0;
    }
    if (!!prevCompB !== !!this.compB) {
      this.updateCompB(this.compB ? PinOverrideMode.Enable : PinOverrideMode.None);
    }
    if (this.hasOCRC) {
      const prevCompC = this.compC;
      this.compC = TCCRA >> 2 & 3;
      if (this.compC === 1 && pwmMode) {
        this.compC = 0;
      }
      if (!!prevCompC !== !!this.compC) {
        this.updateCompC(this.compC ? PinOverrideMode.Enable : PinOverrideMode.None);
      }
    }
  }
  phasePwmCount(value, delta) {
    const { ocrA, ocrB, ocrC, hasOCRC, TOP, MAX, tcntUpdated } = this;
    if (!value && !TOP) {
      delta = 0;
      if (this.ocrUpdateMode === OCRUpdateMode.Top) {
        this.ocrA = this.nextOcrA;
        this.ocrB = this.nextOcrB;
        this.ocrC = this.nextOcrC;
      }
    }
    while (delta > 0) {
      if (this.countingUp) {
        value++;
        if (value === TOP && !tcntUpdated) {
          this.countingUp = false;
          if (this.ocrUpdateMode === OCRUpdateMode.Top) {
            this.ocrA = this.nextOcrA;
            this.ocrB = this.nextOcrB;
            this.ocrC = this.nextOcrC;
          }
        }
      } else {
        value--;
        if (!value && !tcntUpdated) {
          this.countingUp = true;
          this.cpu.setInterruptFlag(this.OVF);
          if (this.ocrUpdateMode === OCRUpdateMode.Bottom) {
            this.ocrA = this.nextOcrA;
            this.ocrB = this.nextOcrB;
            this.ocrC = this.nextOcrC;
          }
        }
      }
      if (!tcntUpdated) {
        if (value === ocrA) {
          this.cpu.setInterruptFlag(this.OCFA);
          if (this.compA) {
            this.updateCompPin(this.compA, "A");
          }
        }
        if (value === ocrB) {
          this.cpu.setInterruptFlag(this.OCFB);
          if (this.compB) {
            this.updateCompPin(this.compB, "B");
          }
        }
        if (hasOCRC && value === ocrC) {
          this.cpu.setInterruptFlag(this.OCFC);
          if (this.compC) {
            this.updateCompPin(this.compC, "C");
          }
        }
      }
      delta--;
    }
    return value & MAX;
  }
  timerUpdated(value, prevValue) {
    const { ocrA, ocrB, ocrC, hasOCRC } = this;
    const overflow = prevValue > value;
    if ((prevValue < ocrA || overflow) && value >= ocrA || prevValue < ocrA && overflow) {
      this.cpu.setInterruptFlag(this.OCFA);
      if (this.compA) {
        this.updateCompPin(this.compA, "A");
      }
    }
    if ((prevValue < ocrB || overflow) && value >= ocrB || prevValue < ocrB && overflow) {
      this.cpu.setInterruptFlag(this.OCFB);
      if (this.compB) {
        this.updateCompPin(this.compB, "B");
      }
    }
    if (hasOCRC && ((prevValue < ocrC || overflow) && value >= ocrC || prevValue < ocrC && overflow)) {
      this.cpu.setInterruptFlag(this.OCFC);
      if (this.compC) {
        this.updateCompPin(this.compC, "C");
      }
    }
  }
  checkForceCompare(value) {
    if (this.timerMode == TimerMode.FastPWM || this.timerMode == TimerMode.PWMPhaseCorrect || this.timerMode == TimerMode.PWMPhaseFrequencyCorrect) {
      return;
    }
    if (value & FOCA) {
      this.updateCompPin(this.compA, "A");
    }
    if (value & FOCB) {
      this.updateCompPin(this.compB, "B");
    }
    if (this.config.compPortC && value & FOCC) {
      this.updateCompPin(this.compC, "C");
    }
  }
  updateCompPin(compValue, pinName, bottom = false) {
    let newValue = PinOverrideMode.None;
    const invertingMode = compValue === 3;
    const isSet = this.countingUp === invertingMode;
    switch (this.timerMode) {
      case Normal:
      case CTC:
        newValue = compToOverride(compValue);
        break;
      case FastPWM:
        if (compValue === 1) {
          newValue = bottom ? PinOverrideMode.None : PinOverrideMode.Toggle;
        } else {
          newValue = invertingMode !== bottom ? PinOverrideMode.Set : PinOverrideMode.Clear;
        }
        break;
      case PWMPhaseCorrect:
      case PWMPhaseFrequencyCorrect:
        if (compValue === 1) {
          newValue = PinOverrideMode.Toggle;
        } else {
          newValue = isSet ? PinOverrideMode.Set : PinOverrideMode.Clear;
        }
        break;
    }
    if (newValue !== PinOverrideMode.None) {
      if (pinName === "A") {
        this.updateCompA(newValue);
      } else if (pinName === "B") {
        this.updateCompB(newValue);
      } else {
        this.updateCompC(newValue);
      }
    }
  }
  updateCompA(value) {
    const { compPortA, compPinA } = this.config;
    const port = this.cpu.gpioByPort[compPortA];
    port === null || port === void 0 ? void 0 : port.timerOverridePin(compPinA, value);
  }
  updateCompB(value) {
    const { compPortB, compPinB } = this.config;
    const port = this.cpu.gpioByPort[compPortB];
    port === null || port === void 0 ? void 0 : port.timerOverridePin(compPinB, value);
  }
  updateCompC(value) {
    const { compPortC, compPinC } = this.config;
    const port = this.cpu.gpioByPort[compPortC];
    port === null || port === void 0 ? void 0 : port.timerOverridePin(compPinC, value);
  }
};

// work/avr-bridge/node_modules/avr8js/dist/esm/peripherals/timer-attiny.js
var CTC1 = 1 << 7;
var PWM1A = 1 << 6;
var PWM1B_BIT = 1 << 6;
var FOC1B = 1 << 3;
var FOC1A = 1 << 2;
var PSR1 = 1 << 1;
var attinyTimer1Config = {
  TCCR1: 80,
  GTCCR: 76,
  TCNT1: 79,
  OCR1A: 78,
  OCR1B: 75,
  OCR1C: 77,
  TIFR: 88,
  TIMSK: 89,
  ovfInterrupt: 4,
  compAInterrupt: 3,
  compBInterrupt: 9,
  TOV1: 1 << 2,
  OCF1A: 1 << 6,
  OCF1B: 1 << 5,
  TOIE1: 1 << 2,
  OCIE1A: 1 << 6,
  OCIE1B: 1 << 5,
  compPortB: 56,
  compPinA: 1,
  // PB1
  compPinB: 4,
  // PB4
  dividers: {
    0: 0,
    1: 1,
    2: 2,
    3: 4,
    4: 8,
    5: 16,
    6: 32,
    7: 64,
    8: 128,
    9: 256,
    10: 512,
    11: 1024,
    12: 2048,
    13: 4096,
    14: 8192,
    15: 16384
  }
};

// work/avr-bridge/node_modules/avr8js/dist/esm/peripherals/twi.js
var TWSR_TWPS1 = 2;
var TWSR_TWPS0 = 1;
var TWSR_TWPS_MASK = TWSR_TWPS1 | TWSR_TWPS0;

// work/avr-bridge/node_modules/avr8js/dist/esm/peripherals/usart.js
var UCSRB_RXEN = 16;
var UCSRB_TXEN = 8;
var UCSRB_UCSZ2 = 4;
var UCSRB_CFG_MASK = UCSRB_UCSZ2 | UCSRB_RXEN | UCSRB_TXEN;

// work/avr-bridge/node_modules/avr8js/dist/esm/peripherals/usi.js
var USIDC = 1 << 4;
var USIPF = 1 << 5;
var USIOIF = 1 << 6;
var USISIF = 1 << 7;
var USITC = 1 << 0;
var USICLK = 1 << 1;
var USICS0 = 1 << 2;
var USICS1 = 1 << 3;
var USIWM0 = 1 << 4;
var USIWM1 = 1 << 5;
var USIOIE = 1 << 6;
var USISIE = 1 << 7;

// work/avr-bridge/node_modules/avr8js/dist/esm/peripherals/watchdog.js
var WDTCSR_WDP3 = 32;
var WDTCSR_WDE = 8;
var WDTCSR_WDP2 = 4;
var WDTCSR_WDP1 = 2;
var WDTCSR_WDP0 = 1;
var WDTCSR_WDP210 = WDTCSR_WDP2 | WDTCSR_WDP1 | WDTCSR_WDP0;
var WDTCSR_PROTECT_MASK = WDTCSR_WDE | WDTCSR_WDP3 | WDTCSR_WDP210;

// work/avr-bridge/uno-runtime.mjs
var clockHz = 16e6;
var pwmPeriod = 1600 / clockHz;
var names = ["D2_UH", "D3_UL", "D4_VH", "D5_VL", "D6_WH", "D7_WL"];
var angleAddress = 258;
var frameStartAddress = 270;
function programFromHex(text) {
  const bytes = new Uint8Array(32768);
  let upper = 0;
  for (const line of text.trim().split(/\r?\n/)) {
    if (!/^:(?:[A-Fa-f0-9]{2})+$/.test(line)) throw new Error("Invalid Arduino HEX record");
    const record = Uint8Array.from(line.slice(1).match(/../g), (h) => parseInt(h, 16));
    const [len, hi, lo, kind] = record;
    if (record.length !== len + 5 || (record.reduce((sum, n) => sum + n, 0) & 255) !== 0) throw new Error("Invalid Arduino HEX checksum");
    const offset = hi << 8 | lo;
    if (kind === 1) break;
    if (kind === 4) upper = (record[4] * 256 + record[5]) * 65536;
    else if (kind === 0) bytes.set(record.subarray(4, 4 + len), upper + offset);
  }
  const words = new Uint16Array(bytes.length / 2);
  for (let i = 0; i < words.length; i++) words[i] = bytes[2 * i] | bytes[2 * i + 1] << 8;
  return words;
}
function createUno(hex, hzAddress) {
  const cpu = new CPU(programFromHex(hex));
  const portB = new AVRIOPort(cpu, portBConfig);
  new AVRIOPort(cpu, portDConfig);
  const adc = new AVRADC(cpu, adcConfig);
  const timer = new AVRTimer(cpu, timer1Config);
  let carrierOrigin;
  return {
    get cycles() {
      return cpu.cycles;
    },
    get gates() {
      return cpu.data[portDConfig.PORT] & cpu.data[portDConfig.DDR] & 252;
    },
    get forward() {
      return (cpu.data[portBConfig.PORT] & 4) !== 0;
    },
    get running() {
      return (cpu.data[portBConfig.PORT] & 8) !== 0;
    },
    get hz() {
      return cpu.data[hzAddress];
    },
    get electricalAngle() {
      return cpu.dataView.getUint16(angleAddress, true) * (2 * Math.PI / 65536);
    },
    get carrierOrigin() {
      return carrierOrigin;
    },
    setInputs(percent, forward, run) {
      adc.channelValues[0] = 5 * Math.max(0, Math.min(100, percent)) / 100;
      portB.setPin(0, forward);
      portB.setPin(1, !run);
    },
    step() {
      avrInstruction(cpu);
      cpu.tick();
    },
    advance(target) {
      while (cpu.cycles < target) {
        avrInstruction(cpu);
        cpu.tick();
      }
      if (carrierOrigin === void 0) {
        const deadline = cpu.dataView.getUint16(frameStartAddress, true);
        if (deadline && timer.debugTCNT) {
          const remaining = (deadline - timer.debugTCNT + 32768 & 65535) - 32768;
          carrierOrigin = (cpu.cycles + remaining) / clockHz;
        }
      }
    }
  };
}

// work/avr-bridge/frequency-plot.mjs
function drawFrequencyPlot(canvas2, history, elapsed, maxHz) {
  const width = canvas2.clientWidth;
  const height = canvas2.clientHeight;
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (canvas2.width !== pixelWidth || canvas2.height !== pixelHeight) {
    canvas2.width = pixelWidth;
    canvas2.height = pixelHeight;
  }
  const ctx = canvas2.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const left = 35;
  const top = 14;
  const right = width - 15;
  const bottom = height - 30;
  const end = Math.max(0.01, elapsed);
  const start = Math.max(0, end - 0.03);
  const x = (time) => left + (time - start) / (end - start) * (right - left);
  const y = (hz) => bottom - hz / maxHz * (bottom - top);
  ctx.font = "11px system-ui, sans-serif";
  ctx.strokeStyle = "#34475d";
  ctx.fillStyle = "#bbccdf";
  ctx.beginPath();
  for (let tick = 0; tick <= 4; tick++) {
    const hz = maxHz * tick / 4;
    const row = y(hz);
    ctx.moveTo(left, row);
    ctx.lineTo(right, row);
    ctx.textAlign = "right";
    ctx.fillText(hz, left - 7, row + 4);
  }
  for (let tick = 0; tick <= 4; tick++) {
    const time = start + tick / 4 * (end - start);
    const column = x(time);
    ctx.moveTo(column, top);
    ctx.lineTo(column, bottom);
    ctx.textAlign = "center";
    ctx.fillText((time * 1e3).toFixed(1), column, bottom + 15);
  }
  ctx.stroke();
  const initial = history.findLast((sample) => sample.time <= start) ?? history[0];
  if (!initial) return;
  const visible = history.filter((sample) => sample.time > start);
  function drawSeries(field, color, dash) {
    let value = initial[field];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(left, y(value));
    for (const sample of visible) {
      ctx.lineTo(x(sample.time), y(value));
      value = sample[field];
      ctx.lineTo(x(sample.time), y(value));
    }
    ctx.lineTo(x(Math.max(start, elapsed)), y(value));
    ctx.stroke();
  }
  drawSeries("target", "#f9c89f", [5, 4]);
  drawSeries("output", "#86efac", []);
  ctx.lineWidth = 1;
}

// work/avr-bridge/transform-signals.mjs
var sampleInterval = pwmPeriod / 100;
function carrierFrame(time, origin) {
  return Math.floor((time - origin) / pwmPeriod + 1e-9);
}
function createVoltageMeasurement() {
  let previous, nextSample, frame, areaAlpha, areaBeta, duration;
  let result;
  function reset() {
    nextSample = 0;
    previous = frame = void 0;
    areaAlpha = areaBeta = duration = 0;
    result = { alpha: 0, beta: 0, d: 0, q: 0, hz: -1, forward: true };
  }
  reset();
  function integrate(endAlpha, endBeta, elapsed) {
    areaAlpha += (previous.alpha + endAlpha) * elapsed / 2;
    areaBeta += (previous.beta + endBeta) * elapsed / 2;
    duration += elapsed;
  }
  function finishFrame() {
    if (duration < pwmPeriod * 0.98) return;
    const alpha = areaAlpha / duration, beta = areaBeta / duration;
    if (!Number.isFinite(alpha) || !Number.isFinite(beta)) return;
    const cosine = Math.cos(frame.angle), sine = Math.sin(frame.angle);
    const d = alpha * cosine + beta * sine;
    const q = beta * cosine - alpha * sine;
    const gain = frame.hz > 0 ? -Math.expm1(-8 * frame.hz * pwmPeriod) : 0.4;
    const continuous = result.hz === frame.hz && result.forward === frame.forward;
    result = {
      alpha,
      beta,
      d: continuous ? result.d + gain * (d - result.d) : d,
      q: continuous ? result.q + gain * (q - result.q) : q,
      hz: frame.hz,
      forward: frame.forward
    };
  }
  function sample(time, motor2, uno2) {
    const origin = uno2.carrierOrigin;
    if (origin === void 0 || time < origin || time < nextSample) return;
    nextSample += sampleInterval;
    if (nextSample <= time) nextSample = time + sampleInterval;
    const index = carrierFrame(time, origin);
    const u = motor2.getVoltage(0) - motor2.getVoltage(1);
    const v = motor2.getVoltage(2) - motor2.getVoltage(3);
    const w = motor2.getVoltage(4) - motor2.getVoltage(5);
    const alpha = (2 * u - v - w) / 3;
    const beta = (v - w) / Math.sqrt(3);
    if (frame?.index === index) {
      integrate(alpha, beta, time - previous.time);
    } else {
      const boundary = origin + index * pwmPeriod;
      let boundarySample;
      if (frame?.index === index - 1 && time > previous.time) {
        const elapsed = Math.max(0, boundary - previous.time);
        const fraction = Math.min(1, elapsed / (time - previous.time));
        boundarySample = {
          time: boundary,
          alpha: previous.alpha + fraction * (alpha - previous.alpha),
          beta: previous.beta + fraction * (beta - previous.beta)
        };
        integrate(boundarySample.alpha, boundarySample.beta, elapsed);
        finishFrame();
      }
      frame = { index, angle: uno2.electricalAngle, hz: uno2.running ? uno2.hz : 0, forward: uno2.forward };
      areaAlpha = areaBeta = duration = 0;
      if (boundarySample) {
        previous = boundarySample;
        integrate(alpha, beta, Math.max(0, time - boundary));
      }
    }
    previous = { time, alpha, beta };
  }
  function read(angle) {
    const { alpha, beta, d, q } = result;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    return {
      raw: { alpha, beta, d: alpha * cosine + beta * sine, q: beta * cosine - alpha * sine },
      filtered: { alpha: d * cosine - q * sine, beta: d * sine + q * cosine, d, q }
    };
  }
  return { reset, sample, read };
}

// work/avr-bridge/transform-view.mjs
var fullTurn = 2 * Math.PI;
var visiblePeriods = 3;
var timeSpan = visiblePeriods * pwmPeriod;
var phaseBits = [1 << 2, 1 << 4, 1 << 6];
var phaseLabels = ["U", "V", "W"];
var cyan = "#67e8f9";
var amber = "#fbbf24";
var violet = "#c4b5fd";
var textColor = "#d5e1f5";
var gridColor = "#31455f";
var format = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
function prepareCanvas(canvas2) {
  const width = canvas2.clientWidth, height = canvas2.clientHeight;
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * scale), pixelHeight = Math.round(height * scale);
  if (canvas2.width !== pixelWidth || canvas2.height !== pixelHeight) {
    canvas2.width = pixelWidth;
    canvas2.height = pixelHeight;
  }
  const ctx = canvas2.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}
function arrow(ctx, x, y, endX, endY, color, width = 1.5) {
  const direction = Math.atan2(endY - y, endX - x);
  const head = width > 2 ? 10 : 7;
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(endX, endY);
  ctx.lineTo(endX - head * Math.cos(direction - 0.48), endY - head * Math.sin(direction - 0.48));
  ctx.lineTo(endX - head * Math.cos(direction + 0.48), endY - head * Math.sin(direction + 0.48));
  ctx.closePath();
  ctx.fill();
}
function drawPwm(canvas2, points, end) {
  const target = prepareCanvas(canvas2);
  if (!target) return;
  const { ctx, width, height } = target;
  const left = 28, right = width - 13;
  const start = end - timeSpan;
  const x = (tick) => left + (tick - start) / timeSpan * (right - left);
  const floor = height - 28;
  const initial = points.findLast((point) => point.time <= start);
  const visible = points.filter((point) => point.time > start && point.time <= end);
  ctx.font = "12px system-ui, sans-serif";
  ctx.beginPath();
  ctx.strokeStyle = gridColor;
  for (let period = 0; period <= visiblePeriods; period++) {
    const col = x(start + period * pwmPeriod);
    ctx.moveTo(col, 12);
    ctx.lineTo(col, floor);
  }
  ctx.stroke();
  for (const [index, bit] of phaseBits.entries()) {
    const color = [cyan, amber, violet][index];
    const low = (index + 1) * floor / 3 - 5, high = low - 23;
    const y = (mask) => mask & bit ? high : low;
    let state = initial?.mask ?? 0;
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.fillText(phaseLabels[index], 8, (high + low) / 2 + 4);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(left, y(state));
    for (const { time: tick, mask } of visible) {
      ctx.lineTo(x(tick), y(state));
      state = mask;
      ctx.lineTo(x(tick), y(state));
    }
    ctx.lineTo(x(end), y(state));
    ctx.stroke();
  }
  arrow(ctx, left, floor, right, floor, textColor);
  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.fillText("3 chu k\u1EF3 \xB7 100 \xB5s/chu k\u1EF3", (left + right) / 2, height - 9);
}
function frameDuty(points, end, bit) {
  let previous = end - pwmPeriod;
  let mask = points.findLast((point) => point.time <= previous)?.mask ?? 0;
  let highTime = 0;
  for (const point of points) {
    if (point.time <= previous) continue;
    if (point.time > end) break;
    if (mask & bit) highTime += point.time - previous;
    previous = point.time;
    mask = point.mask;
  }
  if (mask & bit) highTime += end - previous;
  return highTime / pwmPeriod * 100;
}
function drawVector(canvas2, voltage, angle, rotating, forward) {
  const target = prepareCanvas(canvas2);
  if (!target) return;
  const { ctx, width, height } = target;
  const x = width / 2, y = height / 2;
  const radius = Math.min(width, height) * 0.32;
  const axis = radius * 1.2;
  ctx.strokeStyle = "#55708f";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, fullTurn);
  ctx.stroke();
  ctx.setLineDash([]);
  const fixed = rotating ? "#758ba7" : textColor;
  arrow(ctx, x - axis, y, x + axis, y, fixed);
  arrow(ctx, x, y + axis, x, y - axis, fixed);
  ctx.font = "600 15px system-ui, sans-serif";
  ctx.fillStyle = fixed;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("\u03B1", x + axis + 10, y + (rotating ? 14 : 0));
  ctx.fillText("\u03B2", x - (rotating ? 14 : 0), y - axis - 10);
  if (rotating) {
    for (const [axisAngle, color, label] of [[angle, cyan, "d"], [angle + Math.PI / 2, amber, "q"]]) {
      const dx = Math.cos(axisAngle), dy = -Math.sin(axisAngle);
      arrow(ctx, x - axis * dx, y - axis * dy, x + axis * dx, y + axis * dy, color);
      ctx.fillStyle = color;
      ctx.fillText(label, x + (axis + 10) * dx, y + (axis + 10) * dy);
    }
  } else {
    const guideRadius = radius + 5;
    const start = forward ? -1.96 : -2.55, end = forward ? -2.55 : -1.96;
    ctx.strokeStyle = "#3c7997";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, guideRadius, start, end, forward);
    ctx.stroke();
    const endX = x + guideRadius * Math.cos(end), endY = y + guideRadius * Math.sin(end);
    const tangent = end + (forward ? -Math.PI / 2 : Math.PI / 2);
    arrow(ctx, endX - 9 * Math.cos(tangent), endY - 9 * Math.sin(tangent), endX, endY, "#3c7997");
  }
  const magnitude = Math.hypot(voltage.alpha, voltage.beta);
  if (magnitude >= 0.5) {
    const scale = Math.min(radius / 90, radius * 1.12 / magnitude);
    arrow(ctx, x, y, x + voltage.alpha * scale, y - voltage.beta * scale, cyan, 3);
  }
  ctx.fillStyle = textColor;
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, fullTurn);
  ctx.fill();
}
function createTransformView(panel, readState) {
  const pwmChart = panel.querySelector("#uvw-figure");
  const alphaBetaChart = panel.querySelector("#alphabeta-figure");
  const dqChart = panel.querySelector("#dq-figure");
  const readouts = ["alpha", "beta", "d", "q", "angle"].map((name) => panel.querySelector("#vector-" + name));
  const dutyLabels = phaseLabels.map((phase) => panel.querySelector("#duty-" + phase.toLowerCase()));
  const filter = panel.querySelector("#vector-filter");
  const filterStatus = panel.querySelector("#vector-filter-status");
  const vectorMode = panel.querySelector("#vector-mode");
  const rawLabel = panel.querySelector("#vector-raw");
  const filteredLabel = panel.querySelector("#vector-filtered");
  const gates = [];
  const measurement = createVoltageMeasurement();
  let previousMask = -1;
  function reset() {
    gates.length = 0;
    measurement.reset();
    previousMask = -1;
  }
  function recordGates(time, mask) {
    const highMask = mask & (phaseBits[0] | phaseBits[1] | phaseBits[2]);
    if (previousMask === highMask) return;
    previousMask = highMask;
    gates.push({ time, mask: highMask });
    while (gates.length > 1 && gates[1].time < time - timeSpan - pwmPeriod) gates.shift();
  }
  function draw() {
    if (panel.hidden) return;
    const { time, angle, forward, origin } = readState();
    const { raw, filtered } = measurement.read(angle);
    const voltage = filter.checked ? filtered : raw;
    const status = filter.checked ? "B\u1EADt" : "T\u1EAFt";
    if (filterStatus.textContent !== status) {
      filterStatus.textContent = status;
      vectorMode.textContent = filter.checked ? "Sau l\u1ECDc" : "Tr\u01B0\u1EDBc l\u1ECDc";
    }
    const values = [voltage.alpha, voltage.beta, voltage.d, voltage.q, angle * 360 / fullTurn];
    for (const [index, reading] of readouts.entries()) {
      const value = Math.abs(values[index]) < 0.05 ? 0 : values[index];
      reading.textContent = format.format(value) + (index === 4 ? "\xB0" : " V");
    }
    const end = origin === void 0 ? timeSpan : origin + Math.max(visiblePeriods, carrierFrame(time, origin)) * pwmPeriod;
    for (const [index, label] of dutyLabels.entries()) {
      label.textContent = format.format(frameDuty(gates, end, phaseBits[index])) + "%";
    }
    rawLabel.textContent = format.format(Math.hypot(raw.alpha, raw.beta)) + " V";
    filteredLabel.textContent = format.format(Math.hypot(filtered.alpha, filtered.beta)) + " V";
    drawPwm(pwmChart, gates, end);
    drawVector(alphaBetaChart, voltage, angle, false, forward);
    drawVector(dqChart, voltage, angle, true, forward);
  }
  filter.addEventListener("change", draw);
  return { draw, reset, recordGates, sampleVoltage: measurement.sample };
}

// work/avr-bridge/panel.mjs
var byId = (id) => document.getElementById(id);
var canvas = byId("circuit");
var schematic = byId("schematic");
var speed = byId("speed");
var speedLimitRpm = Number(speed.dataset.limit);
var commandRangeRpm = Number(speed.max);
var frequencyChart = byId("frequency-chart");
var inertia = byId("inertia");
var reverseSwitch = byId("direction");
var runButton = byId("run");
var rotorFace = byId("rotor");
var timeScale = byId("time-scale");
var rotorStopRpm = 0.025;
var rotorTimingThreshold = 0.1;
var minimumRunRpm = 150;
var requestedRun = false;
var lastMask = -1;
var lastTime = 0;
var sim;
var uno;
var motor;
var lastRotorAngle;
var lastDiagramFrame = 0;
var paceSample;
var frequencyHistory = [];
var nextTelemetryTime = 0;
var startup;
var frequencyAddress = 272;
var motorPoles = 4;
var rpmFormat = new Intl.NumberFormat("vi-VN");
var fourDecimalFormat = new Intl.NumberFormat("vi-VN", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
var wallSecondsFormat = new Intl.NumberFormat("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
var rpmText = (rpm) => rpmFormat.format(rpm) + " RPM";
var synchronousRpm = (hz) => rpmText(120 * hz / motorPoles);
var commandHz = () => speed.valueAsNumber * motorPoles / 120;
var emittedHz = () => uno.running ? uno.hz : 0;
var schematicTab = byId("schematic-tab");
var transformTab = byId("transform-tab");
var tabs = [schematicTab, transformTab];
var transformPanel = byId("transforms");
var transformView = createTransformView(transformPanel, () => ({
  time: sim?.getTime() ?? 0,
  angle: uno?.electricalAngle ?? 0,
  forward: uno?.forward ?? true,
  origin: uno?.carrierOrigin
}));
function selectTab(tab) {
  for (const button of tabs) {
    button.setAttribute("aria-selected", String(button === tab));
    button.tabIndex = button === tab ? 0 : -1;
    byId(button.getAttribute("aria-controls")).hidden = button !== tab;
  }
  transformView.draw();
}
for (const tab of tabs) tab.addEventListener("click", () => selectTab(tab));
byId("simulation-tabs").addEventListener("keydown", (event) => {
  const index = tabs.indexOf(event.target);
  if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const move = event.key === "ArrowLeft" ? -1 : 1;
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + move + tabs.length) % tabs.length;
  selectTab(tabs[next]);
  tabs[next].focus();
});
document.querySelector('a[href="#scope-guide"]').addEventListener("click", () => selectTab(schematicTab));
selectTab(location.hash === "#transforms" ? transformTab : schematicTab);
function clearFrequencyTrace() {
  frequencyHistory = [];
  nextTelemetryTime = 0;
}
function startTiming() {
  if (speed.valueAsNumber < minimumRunRpm) return;
  startup = { target: commandHz(), sim: sim.getTime(), wall: performance.now(), frequencyPending: true, rotorPending: true };
  byId("frequency-delay").textContent = byId("rotor-delay").textContent = "\u0110ang \u0111o\u2026";
}
function stopTiming() {
  if (!startup) return;
  if (startup.frequencyPending) byId("frequency-delay").textContent = "D\u1EEBng \u0111o";
  if (startup.rotorPending) byId("rotor-delay").textContent = "D\u1EEBng \u0111o";
  startup = void 0;
}
function recordTelemetry(time) {
  const output = emittedHz();
  const target = commandHz();
  const last = frequencyHistory.at(-1);
  if (last?.target !== target || last?.output !== output) {
    const reading = { time, target, output };
    if (last?.time === time) frequencyHistory[frequencyHistory.length - 1] = reading;
    else frequencyHistory.push(reading);
    while (frequencyHistory.length > 2 && frequencyHistory[1].time < time - 0.03) frequencyHistory.shift();
  }
  if (!startup) return;
  const frequencyReached = startup.frequencyPending && output === startup.target;
  const rotorStarted = startup.rotorPending && Math.abs(motor.getRotorState().rpm) >= rotorTimingThreshold;
  if (!frequencyReached && !rotorStarted) return;
  const wall = wallSecondsFormat.format((performance.now() - startup.wall) / 1e3);
  const elapsed = fourDecimalFormat.format(Math.max(0, time - startup.sim));
  const delay = wall + " s th\u1EF1c \xB7 " + elapsed + " s m\xF4 ph\u1ECFng";
  if (frequencyReached) {
    byId("frequency-delay").textContent = delay;
    startup.frequencyPending = false;
  }
  if (rotorStarted) {
    byId("rotor-delay").textContent = delay;
    startup.rotorPending = false;
  }
  if (!startup.frequencyPending && !startup.rotorPending) startup = void 0;
}
function updateInertia() {
  const value = inertia.valueAsNumber;
  const text = fourDecimalFormat.format(value) + " kg\xB7m\xB2";
  byId("inertia-value").textContent = text;
  inertia.setAttribute("aria-valuetext", text);
  motor?.setRotorInertia(value);
}
function updateTimeScale() {
  const factor = timeScale.valueAsNumber;
  const displayed = rpmFormat.format(factor) + "\xD7";
  byId("time-scale-value").textContent = displayed;
  timeScale.setAttribute("aria-valuetext", displayed);
  sim?.setTimeScale?.(factor);
  paceSample = void 0;
  byId("simulation-pace").textContent = "\u0110ang \u0111o\u2026";
}
function updatePace(time) {
  const wall = performance.now();
  if (!paceSample || time < paceSample.time) paceSample = { time, wall };
  if (wall - paceSample.wall >= 1e3) {
    const rate = (time - paceSample.time) * 1e6 / (wall - paceSample.wall);
    byId("simulation-pace").textContent = fourDecimalFormat.format(rate) + " ms m\xF4 ph\u1ECFng/s th\u1EF1c";
    paceSample = { time, wall };
  }
}
function updateControls() {
  const rpm = speed.valueAsNumber;
  const overLimit = rpm > speedLimitRpm;
  if (overLimit) requestedRun = false;
  if (startup && (!requestedRun || commandHz() !== startup.target)) stopTiming();
  byId("setpoint").textContent = rpmText(rpm);
  byId("target-rpm").textContent = rpmText(rpm);
  byId("overspeed").hidden = !overLimit;
  speed.setAttribute("aria-invalid", String(overLimit));
  speed.setAttribute("aria-valuetext", rpmText(rpm) + (overLimit ? " \xB7 v\u01B0\u1EE3t gi\u1EDBi h\u1EA1n" : ""));
  runButton.disabled = !uno || overLimit;
  runButton.textContent = requestedRun ? "D\u1EEBng" : "Ch\u1EA1y";
  runButton.setAttribute("aria-pressed", String(requestedRun));
  if (uno) {
    uno.setInputs(100 * rpm / commandRangeRpm, !reverseSwitch.checked, requestedRun);
    recordTelemetry(sim.getTime());
  }
  refreshReadouts();
}
function refreshReadouts() {
  if (!sim || !uno) return;
  const output = emittedHz();
  byId("actual").textContent = byId("frequency-output").textContent = output + " Hz";
  byId("frequency-command").textContent = commandHz() + " Hz";
  byId("sync-rpm").textContent = synchronousRpm(output);
  const requestedForward = !reverseSwitch.checked;
  byId("state").textContent = speed.valueAsNumber > speedLimitRpm ? "L\u1ED7i t\u1ED1c \u0111\u1ED9 \u0111\u1EB7t qu\xE1 cao" : !requestedRun ? "\u0110\xE3 ng\u1EAFt l\u1EC7nh ch\u1EA1y" : uno.forward !== requestedForward ? uno.hz ? "\u0110ang gi\u1EA3m t\u1EA7n s\u1ED1 \u0111\u1EC3 \u0111\u1EA3o chi\u1EC1u" : "Ch\u1EDD \u0111\u1EA3o chi\u1EC1u \xB7 PWM t\u1EAFt" : uno.running ? uno.forward ? "\u0110ang ph\xE1t PWM thu\u1EADn" : "\u0110ang ph\xE1t PWM ngh\u1ECBch" : "Ch\u1EDD ph\xE1t PWM";
  const time = sim.getTime();
  byId("simtime").textContent = (time * 1e3).toFixed(1) + " ms";
  const rpm = motor?.getRotorState().rpm ?? 0;
  const moving = Math.abs(rpm) >= rotorStopRpm;
  byId("rpm").textContent = Math.abs(rpm).toFixed(moving && Math.abs(rpm) < 10 ? 2 : 0) + " RPM";
  byId("rotor-status").textContent = !moving ? "\u0110\u1EE9ng y\xEAn" : rpm > 0 ? "C\xF9ng chi\u1EC1u kim \u0111\u1ED3ng h\u1ED3" : "Ng\u01B0\u1EE3c chi\u1EC1u kim \u0111\u1ED3ng h\u1ED3";
  byId("solver").hidden = sim.isRunning();
  updatePace(time);
  drawFrequencyPlot(frequencyChart, frequencyHistory, time, commandRangeRpm * motorPoles / 120);
}
function animateRotor(now) {
  const angle = motor?.getRotorState().angle;
  if (Number.isFinite(angle) && angle !== lastRotorAngle) {
    rotorFace.style.transform = "rotate(" + (angle * 180 / Math.PI % 360).toFixed(3) + "deg)";
    lastRotorAngle = angle;
  }
  if (now - lastDiagramFrame >= 60) {
    transformView.draw();
    lastDiagramFrame = now;
  }
  requestAnimationFrame(animateRotor);
}
speed.addEventListener("input", updateControls);
inertia.addEventListener("input", updateInertia);
timeScale.addEventListener("input", updateTimeScale);
reverseSwitch.addEventListener("change", updateControls);
runButton.addEventListener("click", () => {
  requestedRun = !requestedRun;
  if (requestedRun) startTiming();
  updateControls();
});
byId("expand").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      selectTab(schematicTab);
      await schematic.requestFullscreen();
    }
  } catch {
    canvas.focus();
  }
});
byId("exit-schematic").addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
});
byId("reset").addEventListener("click", () => {
  requestedRun = false;
  updateControls();
  byId("frequency-delay").textContent = byId("rotor-delay").textContent = "Ch\u01B0a \u0111o";
  canvas.contentWindow.location.reload();
});
async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Kh\xF4ng \u0111\u1ECDc \u0111\u01B0\u1EE3c " + url);
  return r.text();
}
var resources = Promise.all([getText("ArduinoInverter/ArduinoInverter.hex"), getText("arduino-inverter.circuitjs")]);
async function attach() {
  try {
    canvas.contentWindow.oncircuitjsloaded = async (api) => {
      try {
        api.setSimRunning(false);
        const [hex, circuit] = await resources;
        api.importCircuit(circuit, false);
        sim = api;
        clearFrequencyTrace();
        transformView.reset();
        lastMask = -1;
        lastTime = 0;
        uno = createUno(hex, frequencyAddress);
        motor = sim.getElements().find((el) => el.getType() === "ThreePhaseMotorElm");
        if (!motor?.getRotorState || !motor.setRotorInertia) throw new Error("Kh\xF4ng truy c\u1EADp \u0111\u01B0\u1EE3c m\xF4 h\xECnh rotor t\u1EEB CircuitJS.");
        lastRotorAngle = void 0;
        updateControls();
        updateInertia();
        updateTimeScale();
        for (const name of names) sim.setExtVoltage(name, 0);
        sim.ontimestep = () => {
          const now = sim.getTime();
          if (now < lastTime) {
            stopTiming();
            clearFrequencyTrace();
            transformView.reset();
            paceSample = void 0;
            uno = createUno(hex, frequencyAddress);
            lastMask = -1;
            lastRotorAngle = void 0;
            updateControls();
          }
          lastTime = now;
          uno.advance(Math.round(now * clockHz));
          transformView.sampleVoltage(now, motor, uno);
          const mask = uno.gates;
          const changes = mask ^ lastMask;
          if (changes !== 0) {
            transformView.recordGates(now, mask);
            names.forEach((name, i) => {
              const bit = 1 << 2 + i;
              if (changes & bit) sim.setExtVoltage(name, mask & bit ? 5 : 0);
            });
            lastMask = mask;
          }
          if (now >= nextTelemetryTime) {
            recordTelemetry(now);
            nextTelemetryTime = now + 5e-5;
          }
        };
        byId("reset").disabled = false;
        byId("loading").hidden = true;
        sim.setSimRunning(true);
        refreshReadouts();
      } catch (err) {
        byId("loading").hidden = false;
        byId("loading").textContent = err.message;
      }
    };
    if (canvas.contentWindow.CircuitJS1) canvas.contentWindow.oncircuitjsloaded(canvas.contentWindow.CircuitJS1);
  } catch (err) {
    byId("loading").textContent = err.message;
  }
}
canvas.addEventListener("load", attach);
var blankCircuit = "$ 1 5e-7 140 40 20 50 5e-10\n";
resources.then(() => {
  canvas.src = "falstad/circuitjs.html?running=false&cct=" + encodeURIComponent(blankCircuit);
}).catch((err) => {
  byId("loading").textContent = err.message;
});
updateControls();
updateInertia();
setInterval(refreshReadouts, 250);
requestAnimationFrame(animateRotor);
