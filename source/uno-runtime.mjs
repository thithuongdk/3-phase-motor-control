import {CPU, AVRIOPort, AVRADC, AVRTimer, adcConfig, avrInstruction, portBConfig, portDConfig, timer1Config} from 'avr8js';

export const clockHz = 16_000_000;
export const names = ['D2_UH','D3_UL','D4_VH','D5_VL','D6_WH','D7_WL'];

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
  new AVRTimer(cpu,timer1Config);
  return {
    get cycles() { return cpu.cycles; },
    get gates() { return cpu.data[portDConfig.PORT]&cpu.data[portDConfig.DDR]&252; },
    get forward() { return (cpu.data[portBConfig.PORT]&4)!==0; },
    get running() { return (cpu.data[portBConfig.PORT]&8)!==0; },
    get hz() { return cpu.data[hzAddress]; },
    setInputs(percent, forward, run) {
      adc.channelValues[0] = 5*Math.max(0,Math.min(100,percent))/100;
      portB.setPin(0,forward);
      portB.setPin(1,!run);
    },
    step() { avrInstruction(cpu); cpu.tick(); },
    advance(target) { while(cpu.cycles<target) { avrInstruction(cpu); cpu.tick(); } }
  };
}
