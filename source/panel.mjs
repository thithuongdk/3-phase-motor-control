import {createUno,clockHz,names} from './uno-runtime.mjs';

const byId=id=>document.getElementById(id);
const canvas=byId('circuit');
const schematic=byId('schematic');
const speed=byId('speed');
const direction=byId('direction');
const runButton=byId('run');
const rotorFace=byId('rotor');
const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
const rotorStopRpm=.025;
let requestedRun=false;
let lastMask=-1, lastTime=0, sim, uno, motor;
let rotorAngle=0, previousFrame;
const frequencyAddress=0x106;
const motorPoles=4; // CircuitJS ThreePhaseMotorElm uses two pole pairs.
const rpmFormat=new Intl.NumberFormat('vi-VN');
const synchronousRpm=hz=>rpmFormat.format(120*hz/motorPoles)+' RPM';

function updateControls() {
  const pct=Number(speed.value);
  const hz=Math.round(pct/2);
  byId('setpoint').textContent=hz<5?'0 Hz (dừng)':hz+' Hz';
  byId('target-rpm').textContent=synchronousRpm(hz<5?0:hz);
  runButton.textContent=requestedRun?'Dừng':'Chạy';
  runButton.setAttribute('aria-pressed',String(requestedRun));
  if(uno) uno.setInputs(pct,direction.value==='forward',requestedRun);
}
function refreshReadouts() {
  if(!sim||!uno) return;
  byId('actual').textContent=uno.hz+' Hz';
  byId('sync-rpm').textContent=synchronousRpm(uno.running?uno.hz:0);
  const requestedForward=direction.value==='forward';
  byId('state').textContent=!requestedRun?'Đã ngắt lệnh chạy':uno.forward!==requestedForward?(uno.hz?'Đang giảm tần số để đảo chiều':'Chờ đảo chiều · PWM tắt'):uno.running?(uno.forward?'Đang phát PWM thuận':'Đang phát PWM nghịch'):'Chờ phát PWM';
  byId('simtime').textContent=(sim.getTime()*1000).toFixed(1)+' ms';
  const rpm=motor?.getRotorState().rpm??0;
  const moving=Math.abs(rpm)>=rotorStopRpm;
  byId('rpm').textContent=Math.abs(rpm).toFixed(moving&&Math.abs(rpm)<10?2:0)+' RPM';
  byId('rotor-status').textContent=!moving?'Đứng yên':rpm>0?'Cùng chiều kim đồng hồ':'Ngược chiều kim đồng hồ';
  byId('solver').hidden=sim.isRunning();
}
function animateRotor(now) {
  const elapsed=previousFrame===undefined?0:Math.min((now-previousFrame)/1000,.05);
  previousFrame=now;
  const state=motor?.getRotorState();
  if(state&&Number.isFinite(state.rpm)) {
    const angleBefore=rotorAngle;
    if(reducedMotion.matches) {
      rotorAngle=state.angle*180/Math.PI;
    } else if(sim.isRunning()&&Math.abs(state.rpm)>=rotorStopRpm) {
      const visualRpm=Math.sign(state.rpm)*Math.min(130,Math.max(9,Math.abs(state.rpm)*2));
      rotorAngle=(rotorAngle+visualRpm*6*elapsed)%360;
    }
    if(rotorAngle!==angleBefore) rotorFace.style.transform='rotate('+rotorAngle.toFixed(2)+'deg)';
  }
  requestAnimationFrame(animateRotor);
}
speed.addEventListener('input',updateControls);
direction.addEventListener('change',updateControls);
runButton.addEventListener('click',()=>{requestedRun=!requestedRun;updateControls();});
byId('expand').addEventListener('click',async()=>{
  try {
    if(document.fullscreenElement) await document.exitFullscreen();
    else await schematic.requestFullscreen();
  } catch { canvas.focus(); }
});
byId('exit-schematic').addEventListener('click',()=>{if(document.fullscreenElement) void document.exitFullscreen();});
byId('reset').addEventListener('click',()=>{
  requestedRun=false;
  updateControls();
  canvas.contentWindow.location.reload();
});

async function getText(url) {
  const r=await fetch(url);
  if(!r.ok) throw new Error('Không đọc được '+url);
  return r.text();
}
const resources=Promise.all([getText('ArduinoInverter/ArduinoInverter.hex'),getText('arduino-inverter.circuitjs')]);

async function attach() {
  try {
    canvas.contentWindow.oncircuitjsloaded=async api=>{
      try {
        api.setSimRunning(false);
        const [hex,circuit]=await resources;
        api.importCircuit(circuit,false);
        sim=api;
        lastMask=-1;
        lastTime=0;
        uno=createUno(hex,frequencyAddress);
        motor=sim.getElements().find(el=>el.getType()==='ThreePhaseMotorElm');
        if(!motor?.getRotorState) throw new Error('Không đọc được tốc độ rotor từ CircuitJS.');
        rotorAngle=0;
        rotorFace.style.transform='';
        updateControls();
        for(const name of names) sim.setExtVoltage(name,0);
        // Advance AVR instructions against the solver's simulated time, not wall time.
        sim.ontimestep=()=>{
          const now=sim.getTime();
          if(now<lastTime) {
            uno=createUno(hex,frequencyAddress);
            lastMask=-1;
            rotorAngle=0;
            rotorFace.style.transform='';
            updateControls();
          }
          lastTime=now;
          uno.advance(Math.round(now*clockHz));
          const mask=uno.gates;
          const changes=mask^lastMask;
          if(changes!==0) {
            names.forEach((name,i)=>{
              const bit=1<<(2+i);
              if(changes&bit) sim.setExtVoltage(name,mask&bit?5:0);
            });
            lastMask=mask;
          }
        };
        runButton.disabled=false;
        byId('reset').disabled=false;
        byId('loading').hidden=true;
        sim.setSimRunning(true);
        refreshReadouts();
      } catch(err) {
        byId('loading').hidden=false;
        byId('loading').textContent=err.message;
      }
    };
    // Every reload has a new content window. The initial hook is set before navigation.
    if(canvas.contentWindow.CircuitJS1) canvas.contentWindow.oncircuitjsloaded(canvas.contentWindow.CircuitJS1);
  } catch(err) {
    byId('loading').textContent=err.message;
  }
}

canvas.addEventListener('load',attach);
// A small blank circuit suppresses CircuitJS's built-in demo while the real circuit is fetched.
const blankCircuit='$ 1 5e-7 140 40 20 50 5e-10\n';
resources.then(()=>{canvas.src='falstad/circuitjs.html?running=false&cct='+encodeURIComponent(blankCircuit);}).catch(err=>{byId('loading').textContent=err.message;});
updateControls();
setInterval(refreshReadouts,250);
requestAnimationFrame(animateRotor);
