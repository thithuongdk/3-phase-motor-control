const turn = 2 * Math.PI;
const phaseStep = turn / 3;
const pwmPeriod = 1 / 10000;
const samplesPerPeriod = 50;
const sampleStep = pwmPeriod / samplesPerPeriod;
const colors = ['#7dd3fc', '#f9c89f', '#c4b5fd', '#7dd3fc', '#f9c89f', '#86efac', '#c4b5fd'];
const dashes = [[], [5, 3], [2, 3], [], [5, 3], [], [5, 3]];
const format = new Intl.NumberFormat('vi-VN', {maximumFractionDigits: 2});

export function clarkePark([u, v, w], angle) {
  const alpha = (2 * u - v - w) / 3;
  const beta = (v - w) / Math.sqrt(3);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [u, v, w, alpha, beta, alpha * cosine + beta * sine, -alpha * sine + beta * cosine];
}

export function createMotorTrace(motor, phaseMeters) {
  const samples = [];
  const voltageSum = [0, 0, 0];
  const currentSum = [0, 0, 0];
  let nextSample = 0;
  let count = 0;
  let midpoint = 0;
  let angle = 0;

  function reset() {
    samples.length = 0;
    voltageSum.fill(0);
    currentSum.fill(0);
    count = 0;
    nextSample = 0;
  }

  function sample(time, uno) {
    if (time < nextSample || phaseMeters.length !== 3) return;
    nextSample += sampleStep;
    if (nextSample <= time) nextSample = time + sampleStep;

    // The motor exposes alternating phase and neutral terminals: U/N, V/N, W/N.
    const neutral = motor.getVoltage(1);
    for (let phase = 0; phase < 3; phase++) {
      voltageSum[phase] += motor.getVoltage(phase * 2) - neutral;
      currentSum[phase] += phaseMeters[phase].getCurrent();
    }
    if (count === samplesPerPeriod / 2) {
      midpoint = time;
      angle = uno.electricalAngle;
    }
    if (++count !== samplesPerPeriod) return;

    const voltage = clarkePark(voltageSum.map(sum => sum / count), angle);
    const current = clarkePark(currentSum.map(sum => sum / count), angle);
    if (voltage.every(Number.isFinite) && current.every(Number.isFinite)) {
      samples.push({time: midpoint, angle, voltage, current});
      if (samples.length > 2500) samples.splice(0, samples.length - 2200);
    }
    voltageSum.fill(0);
    currentSum.fill(0);
    count = 0;
  }

  return {samples, sample, reset};
}

function idealTrace(frequency, forward) {
  const end = frequency ? 1 / frequency : .03;
  const direction = forward ? 1 : -1;
  const points = Array.from({length: 241}, (_, index) => {
    const time = end * index / 240;
    const angle = turn * frequency * time * direction;
    const abc = frequency ? [
      Math.cos(angle), Math.cos(angle - phaseStep), Math.cos(angle + phaseStep)
    ] : [0, 0, 0];
    return {time, angle, values: clarkePark(abc, angle)};
  });
  return {start: 0, end, points};
}

function liveTrace(history, time, frequency, source) {
  const end = Math.max(.005, time);
  const start = Math.max(0, end - 1 / (frequency || 35));
  const points = history.filter(sample => sample.time >= start && sample.time <= end)
    .map(sample => ({time: sample.time, angle: sample.angle, values: sample[source]}));
  return {start, end, points};
}

function traceLimit(points) {
  let peak = 1;
  for (const {values} of points) {
    for (const value of values) peak = Math.max(peak, Math.abs(value));
  }
  const step = 10 ** Math.floor(Math.log10(peak));
  return Math.ceil(peak * 1.08 / (step / 2)) * step / 2;
}

function drawTrace(canvas, fields, trace, limit, selected) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const {start, end, points} = trace;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const left = 43, right = width - 28, top = 9, bottom = height - 24;
  const x = time => left + (time - start) / (end - start) * (right - left);
  const y = value => top + (limit - value) / (2 * limit) * (bottom - top);
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#c1d2e3';
  ctx.strokeStyle = '#30445b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const value of [limit, 0, -limit]) {
    const row = y(value);
    ctx.moveTo(left, row);
    ctx.lineTo(right, row);
    ctx.textAlign = 'right';
    ctx.fillText(format.format(value), left - 6, row + 4);
  }
  for (let tick = 0; tick <= 4; tick++) {
    const time = start + tick / 4 * (end - start);
    const col = x(time);
    ctx.moveTo(col, top);
    ctx.lineTo(col, bottom);
    ctx.textAlign = 'center';
    ctx.fillText(format.format(time * 1000), col, bottom + 15);
  }
  ctx.stroke();
  if (!selected) return;

  for (const field of fields) {
    ctx.strokeStyle = colors[field];
    ctx.lineWidth = 1.8;
    ctx.setLineDash(dashes[field]);
    ctx.beginPath();
    for (const {time, values} of points) ctx.lineTo(x(time), y(values[field]));
    ctx.stroke();
  }

  const col = x(selected.time);
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#d1dae9';
  ctx.beginPath();
  ctx.moveTo(col, top);
  ctx.lineTo(col, bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const field of fields) {
    ctx.fillStyle = colors[field];
    ctx.beginPath();
    ctx.arc(col, y(selected.values[field]), 3, 0, turn);
    ctx.fill();
  }
}

const sourceDetails = {
  voltage: {unit: 'V', note: 'Điện áp từng pha so với điểm sao N tại động cơ, lấy trung bình mỗi 100 µs.'},
  current: {unit: 'A', note: 'Dòng điện từ cầu IGBT vào từng pha động cơ, lấy trung bình mỗi 100 µs.'},
  ideal: {unit: 'p.u.', note: 'Ví dụ ba pha sin cân bằng, biên độ 1 đơn vị tương đối, theo tốc độ và chiều đặt.'}
};

export function createTransformView(panel, readState) {
  const source = panel.querySelector('#transform-source');
  const scrub = panel.querySelector('#transform-cursor');
  const selectedLabel = panel.querySelector('#transform-sample');
  const sourceNote = panel.querySelector('#transform-source-note');
  const unitLabel = panel.querySelector('#transform-unit');
  const charts = Array.from(panel.querySelectorAll('canvas'));
  const fields = [[0, 1, 2], [3, 4], [5, 6]];
  const values = Array.from(panel.querySelectorAll('[data-transform-value]'));
  let message = '';

  function draw() {
    if (panel.hidden) return;
    const state = readState();
    const demo = source.value === 'ideal';
    const details = sourceDetails[source.value];
    const trace = demo ? idealTrace(state.command, state.forward) :
      liveTrace(state.history, state.time, state.hz, source.value);
    const index = Math.round((trace.points.length - 1) * scrub.valueAsNumber / 100);
    const selected = trace.points[index];
    scrub.disabled = !selected;
    const nextMessage = details.note + (!demo && !state.hz ? ' Bấm Chạy để xem tín hiệu khi cấp điện.' : '');
    if (message !== nextMessage) sourceNote.textContent = message = nextMessage;
    unitLabel.textContent = details.unit;
    const degrees = selected ? (selected.angle * 360 / turn + 360) % 360 : 0;
    selectedLabel.textContent = selected ?
      format.format(selected.time * 1000) + ' ms · θₑ ' + format.format(degrees) + '°' : 'Đang chờ mẫu';
    scrub.setAttribute('aria-valuetext', selected ? selectedLabel.textContent : 'Đang chờ mẫu');
    for (const [field, label] of values.entries()) {
      const value = selected?.values[field];
      label.textContent = value === undefined ? '—' : format.format(Math.abs(value) < .005 ? 0 : value);
    }
    const limit = traceLimit(trace.points);
    charts.forEach((chart, index) => drawTrace(chart, fields[index], trace, limit, selected));
  }

  source.addEventListener('change', draw);
  scrub.addEventListener('input', draw);
  return {draw};
}
