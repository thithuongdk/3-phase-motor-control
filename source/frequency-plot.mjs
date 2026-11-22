export function drawFrequencyPlot(canvas, history, elapsed, maxHz) {
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

  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const left = 35;
  const top = 14;
  const right = width - 15;
  const bottom = height - 30;
  const end = Math.max(.01, elapsed);
  const start = Math.max(0, end - .03);
  const x = time => left + (time - start) / (end - start) * (right - left);
  const y = hz => bottom - hz / maxHz * (bottom - top);

  ctx.font = '11px system-ui, sans-serif';
  ctx.strokeStyle = '#34475d';
  ctx.fillStyle = '#bbccdf';
  ctx.beginPath();
  for (let tick = 0; tick <= 4; tick++) {
    const hz = maxHz * tick / 4;
    const row = y(hz);
    ctx.moveTo(left, row);
    ctx.lineTo(right, row);
    ctx.textAlign = 'right';
    ctx.fillText(hz, left - 7, row + 4);
  }
  for (let tick = 0; tick <= 4; tick++) {
    const time = start + tick / 4 * (end - start);
    const column = x(time);
    ctx.moveTo(column, top);
    ctx.lineTo(column, bottom);
    ctx.textAlign = 'center';
    ctx.fillText((time * 1000).toFixed(1), column, bottom + 15);
  }
  ctx.stroke();

  const initial = history.findLast(sample => sample.time <= start) ?? history[0];
  if (!initial) return;
  const visible = history.filter(sample => sample.time > start);
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
  drawSeries('target', '#f9c89f', [5, 4]);
  drawSeries('output', '#86efac', []);
  ctx.lineWidth = 1;
}
