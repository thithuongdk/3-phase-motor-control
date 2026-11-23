import {pwmPeriod} from './uno-runtime.mjs';
import {carrierFrame, createVoltageMeasurement} from './transform-signals.mjs';

const fullTurn = 2 * Math.PI;
const visiblePeriods = 3;
const timeSpan = visiblePeriods * pwmPeriod;
const phaseBits = [1 << 2, 1 << 4, 1 << 6];
const phaseLabels = ['U', 'V', 'W'];
const cyan = '#67e8f9', amber = '#fbbf24', violet = '#c4b5fd';
const textColor = '#d5e1f5', gridColor = '#31455f';
const format = new Intl.NumberFormat('vi-VN', {maximumFractionDigits: 1});

function prepareCanvas(canvas) {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * scale), pixelHeight = Math.round(height * scale);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return {ctx, width, height};
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
  ctx.lineTo(endX - head * Math.cos(direction - .48), endY - head * Math.sin(direction - .48));
  ctx.lineTo(endX - head * Math.cos(direction + .48), endY - head * Math.sin(direction + .48));
  ctx.closePath();
  ctx.fill();
}

function drawPwm(canvas, points, end) {
  const target = prepareCanvas(canvas);
  if (!target) return;
  const {ctx, width, height} = target;
  const left = 28, right = width - 13;
  const start = end - timeSpan;
  const x = tick => left + (tick - start) / timeSpan * (right - left);
  const floor = height - 28;
  const initial = points.findLast(point => point.time <= start);
  const visible = points.filter(point => point.time > start && point.time <= end);
  ctx.font = '12px system-ui, sans-serif';

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
    const y = mask => mask & bit ? high : low;
    let state = initial?.mask ?? 0;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(phaseLabels[index], 8, (high + low) / 2 + 4);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(left, y(state));
    for (const {time: tick, mask} of visible) {
      ctx.lineTo(x(tick), y(state));
      state = mask;
      ctx.lineTo(x(tick), y(state));
    }
    ctx.lineTo(x(end), y(state));
    ctx.stroke();
  }

  arrow(ctx, left, floor, right, floor, textColor);
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.fillText('3 chu kỳ · 100 µs/chu kỳ', (left + right) / 2, height - 9);
}

function frameDuty(points, end, bit) {
  let previous = end - pwmPeriod;
  let mask = points.findLast(point => point.time <= previous)?.mask ?? 0;
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

function drawVector(canvas, voltage, angle, rotating, forward) {
  const target = prepareCanvas(canvas);
  if (!target) return;
  const {ctx, width, height} = target;
  const x = width / 2, y = height / 2;
  const radius = Math.min(width, height) * .32;
  const axis = radius * 1.20;

  ctx.strokeStyle = '#55708f';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, fullTurn);
  ctx.stroke();
  ctx.setLineDash([]);

  const fixed = rotating ? '#758ba7' : textColor;
  arrow(ctx, x - axis, y, x + axis, y, fixed);
  arrow(ctx, x, y + axis, x, y - axis, fixed);
  ctx.font = '600 15px system-ui, sans-serif';
  ctx.fillStyle = fixed;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('α', x + axis + 10, y + (rotating ? 14 : 0));
  ctx.fillText('β', x - (rotating ? 14 : 0), y - axis - 10);

  if (rotating) {
    for (const [axisAngle, color, label] of [[angle, cyan, 'd'], [angle + Math.PI / 2, amber, 'q']]) {
      const dx = Math.cos(axisAngle), dy = -Math.sin(axisAngle);
      arrow(ctx, x - axis * dx, y - axis * dy, x + axis * dx, y + axis * dy, color);
      ctx.fillStyle = color;
      ctx.fillText(label, x + (axis + 10) * dx, y + (axis + 10) * dy);
    }
  } else {
    const guideRadius = radius + 5;
    const start = forward ? -1.96 : -2.55, end = forward ? -2.55 : -1.96;
    ctx.strokeStyle = '#3c7997';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, guideRadius, start, end, forward);
    ctx.stroke();
    const endX = x + guideRadius * Math.cos(end), endY = y + guideRadius * Math.sin(end);
    const tangent = end + (forward ? -Math.PI / 2 : Math.PI / 2);
    arrow(ctx, endX - 9 * Math.cos(tangent), endY - 9 * Math.sin(tangent), endX, endY, '#3c7997');
  }

  const magnitude = Math.hypot(voltage.alpha, voltage.beta);
  if (magnitude >= .5) {
    const scale = Math.min(radius / 90, (radius * 1.12) / magnitude);
    arrow(ctx, x, y, x + voltage.alpha * scale, y - voltage.beta * scale, cyan, 3);
  }
  ctx.fillStyle = textColor;
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, fullTurn);
  ctx.fill();
}

export function createTransformView(panel, readState) {
  const pwmChart = panel.querySelector('#uvw-figure');
  const alphaBetaChart = panel.querySelector('#alphabeta-figure');
  const dqChart = panel.querySelector('#dq-figure');
  const readouts = ['alpha', 'beta', 'd', 'q', 'angle'].map(name => panel.querySelector('#vector-' + name));
  const dutyLabels = phaseLabels.map(phase => panel.querySelector('#duty-' + phase.toLowerCase()));
  const filter = panel.querySelector('#vector-filter');
  const filterStatus = panel.querySelector('#vector-filter-status');
  const vectorMode = panel.querySelector('#vector-mode');
  const rawLabel = panel.querySelector('#vector-raw');
  const filteredLabel = panel.querySelector('#vector-filtered');
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
    gates.push({time, mask: highMask});
    while (gates.length > 1 && gates[1].time < time - timeSpan - pwmPeriod) gates.shift();
  }

  function draw() {
    if (panel.hidden) return;
    const {time, angle, forward, origin} = readState();
    const {raw, filtered} = measurement.read(angle);
    const voltage = filter.checked ? filtered : raw;
    const status = filter.checked ? 'Bật' : 'Tắt';
    if (filterStatus.textContent !== status) {
      filterStatus.textContent = status;
      vectorMode.textContent = filter.checked ? 'Sau lọc' : 'Trước lọc';
    }
    const values = [voltage.alpha, voltage.beta, voltage.d, voltage.q, angle * 360 / fullTurn];
    for (const [index, reading] of readouts.entries()) {
      const value = Math.abs(values[index]) < .05 ? 0 : values[index];
      reading.textContent = format.format(value) + (index === 4 ? '°' : ' V');
    }
    const end = origin === undefined ? timeSpan :
      origin + Math.max(visiblePeriods, carrierFrame(time, origin)) * pwmPeriod;
    for (const [index, label] of dutyLabels.entries()) {
      label.textContent = format.format(frameDuty(gates, end, phaseBits[index])) + '%';
    }
    rawLabel.textContent = format.format(Math.hypot(raw.alpha, raw.beta)) + ' V';
    filteredLabel.textContent = format.format(Math.hypot(filtered.alpha, filtered.beta)) + ' V';
    drawPwm(pwmChart, gates, end);
    drawVector(alphaBetaChart, voltage, angle, false, forward);
    drawVector(dqChart, voltage, angle, true, forward);
  }

  filter.addEventListener('change', draw);
  return {draw, reset, recordGates, sampleVoltage: measurement.sample};
}
