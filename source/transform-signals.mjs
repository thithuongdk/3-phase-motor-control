import {pwmPeriod} from './uno-runtime.mjs';

export function carrierFrame(time, origin) {
  return Math.floor((time - origin) / pwmPeriod + 1e-9);
}

export function createVoltageMeasurement() {
  let previous, frame, result;

  function reset() {
    previous = frame = result = undefined;
  }

  function integrate(alpha, beta, elapsed) {
    frame.areaAlpha += (previous.alpha + alpha) * elapsed / 2;
    frame.areaBeta += (previous.beta + beta) * elapsed / 2;
  }

  function finishFrame(end) {
    if (!frame.completeStart || frame.angle === undefined) return;
    const alpha = frame.areaAlpha / pwmPeriod, beta = frame.areaBeta / pwmPeriod;
    if (!Number.isFinite(alpha) || !Number.isFinite(beta)) return;
    const cosine = Math.cos(frame.angle), sine = Math.sin(frame.angle);
    const d = alpha * cosine + beta * sine;
    const q = beta * cosine - alpha * sine;
    const gain = frame.hz > 0 ? -Math.expm1(-8 * frame.hz * pwmPeriod) : .4;
    const continuous = result?.index === frame.index - 1 &&
      result.running === frame.running && result.forward === frame.forward;
    const filteredD = continuous ? result.filtered.d + gain * (d - result.filtered.d) : d;
    const filteredQ = continuous ? result.filtered.q + gain * (q - result.filtered.q) : q;
    result = {
      index: frame.index, end, angle: frame.angle, forward: frame.forward, running: frame.running,
      raw: {alpha, beta, d, q},
      filtered: {
        alpha: filteredD * cosine - filteredQ * sine,
        beta: filteredD * sine + filteredQ * cosine,
        d: filteredD, q: filteredQ
      }
    };
  }

  function sample(time, motor, uno) {
    const origin = uno.carrierOrigin;
    if (origin === undefined || time < origin) return;
    const index = carrierFrame(time, origin);
    // Use every accepted solver step, including short steps at switching edges.
    const u = motor.getVoltage(0) - motor.getVoltage(1);
    const v = motor.getVoltage(2) - motor.getVoltage(3);
    const w = motor.getVoltage(4) - motor.getVoltage(5);
    const alpha = (2 * u - v - w) / 3;
    const beta = (v - w) / Math.sqrt(3);
    if (frame?.index === index) {
      integrate(alpha, beta, time - previous.time);
    } else {
      const start = origin + index * pwmPeriod;
      const contiguous = frame?.index === index - 1 && time > previous.time;
      if (contiguous) {
        const elapsed = Math.max(0, Math.min(start, time) - previous.time);
        const fraction = elapsed / (time - previous.time);
        const atAlpha = previous.alpha + fraction * (alpha - previous.alpha);
        const atBeta = previous.beta + fraction * (beta - previous.beta);
        integrate(atAlpha, atBeta, elapsed);
        finishFrame(start);
        previous = {time: start, alpha: atAlpha, beta: atBeta};
      }
      frame = {index, start, completeStart: contiguous || time === start, areaAlpha: 0, areaBeta: 0};
      if (contiguous) integrate(alpha, beta, Math.max(0, time - start));
    }
    // Read the active PWM plan after the start-of-frame status updates.
    if (frame.angle === undefined && time >= frame.start + pwmPeriod / 4) {
      frame.angle = uno.electricalAngle;
      frame.hz = uno.hz;
      frame.running = uno.running;
      frame.forward = uno.forward;
    }
    previous = {time, alpha, beta};
  }

  return {reset, sample, read: () => result};
}
