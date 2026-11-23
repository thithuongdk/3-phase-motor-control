import {CPU, AVRIOPort, AVRADC, AVRTimer, adcConfig, avrInstruction, portBConfig, portDConfig, timer1Config} from 'avr8js';

export const clockHz = 16_000_000;
export const pwmPeriod = 1600 / clockHz;
export const names = ['D2_UH','D3_UL','D4_VH','D5_VL','D6_WH','D7_WL'];
// SVPWM angle and Timer1 frame deadline symbols in the published firmware ELF.
const angleAddress = 0x102;
const frameStartAddress = 0x10e;

function programFromHex(text) {
  const bytes = new Uint8Array(32768);
  let upper = 0;
  for (const line of text.trim().split(/\r?\n/)) {
    if (!/^:(?:[A-Fa-f0-9]{2})+$/.test(line)) throw new Error('Invalid Arduino HEX record');
    const record = Uint8Array.from(line.slice(1).match(/../g), h => parseInt(h,16));
    const [len, hi, lo, kind] = record;
    if (record.length !== len+5 || (record.reduce((sum,n)=>sum+n,0)&255)!==0) throw new Error('Invalid Arduino HEX checksum');
    const offset = (hi<<8)|lo;
    if (kind===1) break;
    if (kind===4) upper=(record[4]*256+record[5])*65536;
    else if (kind===0) bytes.set(record.subarray(4,4+len), upper+offset);
  }
  const words=new Uint16Array(bytes.length/2);
  for(let i=0;i<words.length;i++) words[i]=bytes[2*i]|(bytes[2*i+1]<<8);
  return words;
}

export function createUno(hex, hzAddress) {
  const cpu=new CPU(programFromHex(hex));
  const portB=new AVRIOPort(cpu,portBConfig);
  new AVRIOPort(cpu,portDConfig);
  const adc=new AVRADC(cpu,adcConfig);
  const timer = new AVRTimer(cpu,timer1Config);
  let carrierOrigin;
  return {
    get cycles() { return cpu.cycles; },
    get gates() { return cpu.data[portDConfig.PORT]&cpu.data[portDConfig.DDR]&252; },
    get forward() { return (cpu.data[portBConfig.PORT]&4)!==0; },
    get running() { return (cpu.data[portBConfig.PORT]&8)!==0; },
    get hz() { return cpu.data[hzAddress]; },
    get electricalAngle() { return cpu.dataView.getUint16(angleAddress, true) * (2 * Math.PI / 65536); },
    get carrierOrigin() { return carrierOrigin; },
    setInputs(percent, forward, run) {
      adc.channelValues[0] = 5*Math.max(0,Math.min(100,percent))/100;
      portB.setPin(0,forward);
      portB.setPin(1,!run);
    },
    step() { avrInstruction(cpu); cpu.tick(); },
    advance(target) {
      while(cpu.cycles<target) { avrInstruction(cpu); cpu.tick(); }
      if(carrierOrigin===undefined) {
        const deadline=cpu.dataView.getUint16(frameStartAddress,true);
        if(deadline&&timer.debugTCNT) {
          // The free-running timer and CPU advance at one tick per cycle.
          const remaining=((deadline-timer.debugTCNT+32768)&65535)-32768;
          carrierOrigin=(cpu.cycles+remaining)/clockHz;
        }
      }
    }
  };
}
