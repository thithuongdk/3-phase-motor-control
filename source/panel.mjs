import {createUno,clockHz,names} from './uno-runtime.mjs';
import {drawFrequencyPlot} from './frequency-plot.mjs';
import {createTransformView} from './transform-view.mjs';

const byId=id=>document.getElementById(id);
const canvas=byId('circuit');
const schematic=byId('schematic');
const speed=byId('speed');
const speedLimitRpm=Number(speed.dataset.limit);
const commandRangeRpm=Number(speed.max);
const frequencyChart=byId('frequency-chart');
const inertia=byId('inertia');
const reverseSwitch=byId('direction');
const runButton=byId('run');
const rotorFace=byId('rotor');
const timeScale=byId('time-scale');
const rotorStopRpm=.025;
const rotorTimingThreshold=.1;
const minimumRunRpm=150;
let requestedRun=false;
let lastMask=-1, lastTime=0, sim, uno, motor;
let lastRotorAngle, lastDiagramFrame=0, paceSample;
let frequencyHistory=[], nextTelemetryTime=0, startup;
const frequencyAddress=0x110; // electricalHz in the compiled Arduino Uno firmware.
const motorPoles=4; // CircuitJS ThreePhaseMotorElm uses two pole pairs.
const rpmFormat=new Intl.NumberFormat('vi-VN');
const fourDecimalFormat=new Intl.NumberFormat('vi-VN',{minimumFractionDigits:4,maximumFractionDigits:4});
const wallSecondsFormat=new Intl.NumberFormat('vi-VN',{minimumFractionDigits:1,maximumFractionDigits:1});
const rpmText=rpm=>rpmFormat.format(rpm)+' RPM';
const synchronousRpm=hz=>rpmText(120*hz/motorPoles);
const commandHz=()=>speed.valueAsNumber*motorPoles/120;
const emittedHz=()=>uno.running?uno.hz:0;
const schematicTab=byId('schematic-tab');
const transformTab=byId('transform-tab');
const tabs=[schematicTab,transformTab];
const transformPanel=byId('transforms');
const transformView=createTransformView(transformPanel,()=>({
  time:sim?.getTime()??0,
  angle:uno?.electricalAngle??0,
  forward:uno?.forward??true,
  origin:uno?.carrierOrigin
}));

function selectTab(tab) {
  for(const button of tabs) {
    button.setAttribute('aria-selected',String(button===tab));
    button.tabIndex=button===tab?0:-1;
    byId(button.getAttribute('aria-controls')).hidden=button!==tab;
  }
  transformView.draw();
}

for(const tab of tabs) tab.addEventListener('click',()=>selectTab(tab));
byId('simulation-tabs').addEventListener('keydown',event=>{
  const index=tabs.indexOf(event.target);
  if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const move=event.key==='ArrowLeft'?-1:1;
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+move+tabs.length)%tabs.length;
  selectTab(tabs[next]);
  tabs[next].focus();
});
document.querySelector('a[href="#scope-guide"]').addEventListener('click',()=>selectTab(schematicTab));
selectTab(location.hash==='#transforms'?transformTab:schematicTab);

function clearFrequencyTrace() {
  frequencyHistory=[];
  nextTelemetryTime=0;
}

function startTiming() {
  if(speed.valueAsNumber<minimumRunRpm) return;
  startup={target:commandHz(),sim:sim.getTime(),wall:performance.now(),frequencyPending:true,rotorPending:true};
  byId('frequency-delay').textContent=byId('rotor-delay').textContent='Đang đo…';
}

function stopTiming() {
  if(!startup) return;
  if(startup.frequencyPending) byId('frequency-delay').textContent='Dừng đo';
  if(startup.rotorPending) byId('rotor-delay').textContent='Dừng đo';
  startup=undefined;
}

function recordTelemetry(time) {
  const output=emittedHz();
  const target=commandHz();
  const last=frequencyHistory.at(-1);
  if(last?.target!==target||last?.output!==output) {
    const reading={time,target,output};
    if(last?.time===time) frequencyHistory[frequencyHistory.length-1]=reading;
    else frequencyHistory.push(reading);
    while(frequencyHistory.length>2&&frequencyHistory[1].time<time-.03) frequencyHistory.shift();
  }
  if(!startup) return;
  const frequencyReached=startup.frequencyPending&&output===startup.target;
  const rotorStarted=startup.rotorPending&&Math.abs(motor.getRotorState().rpm)>=rotorTimingThreshold;
  if(!frequencyReached&&!rotorStarted) return;
  const wall=wallSecondsFormat.format((performance.now()-startup.wall)/1000);
  const elapsed=fourDecimalFormat.format(Math.max(0,time-startup.sim));
  const delay=wall+' s thực · '+elapsed+' s mô phỏng';
  if(frequencyReached) {
    byId('frequency-delay').textContent=delay;
    startup.frequencyPending=false;
  }
  if(rotorStarted) {
    byId('rotor-delay').textContent=delay;
    startup.rotorPending=false;
  }
  if(!startup.frequencyPending&&!startup.rotorPending) startup=undefined;
}

function updateInertia() {
  const value=inertia.valueAsNumber;
  const text=fourDecimalFormat.format(value)+' kg·m²';
  byId('inertia-value').textContent=text;
  inertia.setAttribute('aria-valuetext',text);
  motor?.setRotorInertia(value);
}

function updateTimeScale() {
  const factor=timeScale.valueAsNumber;
  const displayed=rpmFormat.format(factor)+'×';
  byId('time-scale-value').textContent=displayed;
  timeScale.setAttribute('aria-valuetext',displayed);
  sim?.setTimeScale?.(factor);
  paceSample=undefined;
  byId('simulation-pace').textContent='Đang đo…';
}

function updatePace(time) {
  const wall=performance.now();
  if(!paceSample||time<paceSample.time) paceSample={time,wall};
  if(wall-paceSample.wall>=1000) {
    const rate=(time-paceSample.time)*1e6/(wall-paceSample.wall);
    byId('simulation-pace').textContent=fourDecimalFormat.format(rate)+' ms mô phỏng/s thực';
    paceSample={time,wall};
  }
}

function updateControls() {
  const rpm=speed.valueAsNumber;
  const overLimit=rpm>speedLimitRpm;
  if(overLimit) requestedRun=false;
  if(startup&&(!requestedRun||commandHz()!==startup.target)) stopTiming();
  byId('setpoint').textContent=rpmText(rpm);
  byId('target-rpm').textContent=rpmText(rpm);
  byId('overspeed').hidden=!overLimit;
  speed.setAttribute('aria-invalid',String(overLimit));
  speed.setAttribute('aria-valuetext',rpmText(rpm)+(overLimit?' · vượt giới hạn':''));
  runButton.disabled=!uno||overLimit;
  runButton.textContent=requestedRun?'Dừng':'Chạy';
  runButton.setAttribute('aria-pressed',String(requestedRun));
  if(uno) {
    uno.setInputs(100*rpm/commandRangeRpm,!reverseSwitch.checked,requestedRun);
    recordTelemetry(sim.getTime());
  }
  refreshReadouts();
}
function refreshReadouts() {
  if(!sim||!uno) return;
  const output=emittedHz();
  byId('actual').textContent=byId('frequency-output').textContent=output+' Hz';
  byId('frequency-command').textContent=commandHz()+' Hz';
  byId('sync-rpm').textContent=synchronousRpm(output);
  const requestedForward=!reverseSwitch.checked;
  byId('state').textContent=speed.valueAsNumber>speedLimitRpm?'Lỗi tốc độ đặt quá cao':!requestedRun?'Đã ngắt lệnh chạy':uno.forward!==requestedForward?(uno.hz?'Đang giảm tần số để đảo chiều':'Chờ đảo chiều · PWM tắt'):uno.running?(uno.forward?'Đang phát PWM thuận':'Đang phát PWM nghịch'):'Chờ phát PWM';
  const time=sim.getTime();
  byId('simtime').textContent=(time*1000).toFixed(1)+' ms';
  const rpm=motor?.getRotorState().rpm??0;
  const moving=Math.abs(rpm)>=rotorStopRpm;
  byId('rpm').textContent=Math.abs(rpm).toFixed(moving&&Math.abs(rpm)<10?2:0)+' RPM';
  byId('rotor-status').textContent=!moving?'Đứng yên':rpm>0?'Cùng chiều kim đồng hồ':'Ngược chiều kim đồng hồ';
  byId('solver').hidden=sim.isRunning();
  updatePace(time);
  drawFrequencyPlot(frequencyChart,frequencyHistory,time,commandRangeRpm*motorPoles/120);
}
function animateRotor(now) {
  const angle=motor?.getRotorState().angle;
  if(Number.isFinite(angle)&&angle!==lastRotorAngle) {
    rotorFace.style.transform='rotate('+((angle*180/Math.PI)%360).toFixed(3)+'deg)';
    lastRotorAngle=angle;
  }
  if(now-lastDiagramFrame>=60) {
    transformView.draw();
    lastDiagramFrame=now;
  }
  requestAnimationFrame(animateRotor);
}
speed.addEventListener('input',updateControls);
inertia.addEventListener('input',updateInertia);
timeScale.addEventListener('input',updateTimeScale);
reverseSwitch.addEventListener('change',updateControls);
runButton.addEventListener('click',()=>{
  requestedRun=!requestedRun;
  if(requestedRun) startTiming();
  updateControls();
});
byId('expand').addEventListener('click',async()=>{
  try {
    if(document.fullscreenElement) await document.exitFullscreen();
    else {
      selectTab(schematicTab);
      await schematic.requestFullscreen();
    }
  } catch { canvas.focus(); }
});
byId('exit-schematic').addEventListener('click',()=>{if(document.fullscreenElement) void document.exitFullscreen();});
byId('reset').addEventListener('click',()=>{
  requestedRun=false;
  updateControls();
  byId('frequency-delay').textContent=byId('rotor-delay').textContent='Chưa đo';
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
        clearFrequencyTrace();
        transformView.reset();
        lastMask=-1;
        lastTime=0;
        uno=createUno(hex,frequencyAddress);
        motor=sim.getElements().find(el=>el.getType()==='ThreePhaseMotorElm');
        if(!motor?.getRotorState||!motor.setRotorInertia) throw new Error('Không truy cập được mô hình rotor từ CircuitJS.');
        lastRotorAngle=undefined;
        updateControls();
        updateInertia();
        updateTimeScale();
        for(const name of names) sim.setExtVoltage(name,0);
        // Advance AVR instructions against the solver's simulated time, not wall time.
        sim.ontimestep=()=>{
          const now=sim.getTime();
          if(now<lastTime) {
            stopTiming();
            clearFrequencyTrace();
            transformView.reset();
            paceSample=undefined;
            uno=createUno(hex,frequencyAddress);
            lastMask=-1;
            lastRotorAngle=undefined;
            updateControls();
          }
          lastTime=now;
          uno.advance(Math.round(now*clockHz));
          transformView.sampleVoltage(now,motor,uno);
          const mask=uno.gates;
          const changes=mask^lastMask;
          if(changes!==0) {
            transformView.recordGates(now,mask);
            names.forEach((name,i)=>{
              const bit=1<<(2+i);
              if(changes&bit) sim.setExtVoltage(name,mask&bit?5:0);
            });
            lastMask=mask;
          }
          if(now>=nextTelemetryTime) {
            recordTelemetry(now);
            nextTelemetryTime=now+.00005;
          }
        };
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
updateInertia();
setInterval(refreshReadouts,250);
requestAnimationFrame(animateRotor);
