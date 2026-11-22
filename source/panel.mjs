import {createUno,clockHz,names} from './uno-runtime.mjs';

const byId=id=>document.getElementById(id);
const canvas=byId('circuit');
const speed=byId('speed');
const direction=byId('direction');
const runButton=byId('run');
let requestedRun=false;
let lastMask=-1, lastTime=0, sim, uno, motor;
const frequencyAddress=0x106;

function updateControls() {
  const pct=Number(speed.value);
  const hz=Math.round(pct/2);
  byId('setpoint').textContent=hz<5?'0 Hz (dừng)':hz+' Hz';
  runButton.textContent=requestedRun?'Dừng':'Chạy';
  runButton.setAttribute('aria-pressed',String(requestedRun));
  if(uno) uno.setInputs(pct,direction.value==='forward',requestedRun);
}
function refreshReadouts() {
  if(!sim||!uno) return;
  byId('actual').textContent=uno.hz+' Hz';
  const requestedForward=direction.value==='forward';
  byId('state').textContent=!requestedRun?'Đã ngắt lệnh chạy':uno.forward!==requestedForward?(uno.hz?'Đang giảm tần số để đảo chiều':'Chờ đảo chiều · PWM tắt'):uno.running?(uno.forward?'Đang phát PWM thuận':'Đang phát PWM nghịch'):'Chờ phát PWM';
  byId('simtime').textContent=(sim.getTime()*1000).toFixed(1)+' ms';
  const reading=motor?.getInfo().find(line=>typeof line==='string'&&line.includes('RPM'));
  byId('rpm').textContent=reading?.split(' = ').at(-1)??'0 RPM';
  byId('solver').hidden=sim.isRunning();
}
speed.addEventListener('input',updateControls);
direction.addEventListener('change',updateControls);
runButton.addEventListener('click',()=>{requestedRun=!requestedRun;updateControls();});
byId('expand').addEventListener('click',async()=>{
  try {
    if(document.fullscreenElement) await document.exitFullscreen();
    else await canvas.requestFullscreen();
  } catch { canvas.focus(); }
});
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
const resources=Promise.all([getText('ArduinoInverter/ArduinoInverter.hex'),getText('circuit-boot.txt')]);

async function attach() {
  try {
    canvas.contentWindow.oncircuitjsloaded=async api=>{
      try {
        api.setSimRunning(false);
        const [hex]=await resources;
        sim=api;
        lastMask=-1;
        lastTime=0;
        uno=createUno(hex,frequencyAddress);
        motor=sim.getElements().find(el=>el.getType()==='ThreePhaseMotorElm');
        updateControls();
        for(const name of names) sim.setExtVoltage(name,0);
        // Advance AVR instructions against the solver's simulated time, not wall time.
        sim.ontimestep=()=>{
          const now=sim.getTime();
          if(now<lastTime) {
            uno=createUno(hex,frequencyAddress);
            lastMask=-1;
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
resources.then(([,payload])=>{canvas.src='falstad/circuitjs.html?running=false&ctz='+payload.trim();}).catch(err=>{byId('loading').textContent=err.message;});
updateControls();
setInterval(refreshReadouts,250);
