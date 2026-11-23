import {pwmPeriod} from './uno-runtime.mjs';

const sampleInterval = pwmPeriod / 100;

export function carrierFrame(time, origin) {
  return Math.floor((time - origin) / pwmPeriod + 1e-9);
}

export function createVoltageMeasurement() {
  let previous, nextSample, frame, areaAlpha, areaBeta, duration;
  let result;

  function reset() {
    nextSample = 0;
    previous = frame = undefined;
    areaAlpha = areaBeta = duration = 0;
    result = {alpha: 0, beta: 0, d: 0, q: 0, hz: -1, forward: true};
  }
  reset();

  function integrate(endAlpha, endBeta, elapsed) {
    areaAlpha += (previous.alpha + endAlpha) * elapsed / 2;
    areaBeta += (previous.beta + endBeta) * elapsed / 2;
    duration += elapsed;
  }

  function finishFrame() {
    if (duration < pwmPeriod * .98) return;
    const alpha = areaAlpha / duration, beta = areaBeta / duration;
    if (!Number.isFinite(alpha) || !Number.isFinite(beta)) return;
    const cosine = Math.cos(frame.angle), sine = Math.sin(frame.angle);
    const d = alpha * cosine + beta * sine;
    const q = beta * cosine - alpha * sine;
    // Average in the rotating frame so ripple attenuation does not slow the plotted rotation.
    const gain = frame.hz > 0 ? -Math.expm1(-8 * frame.hz * pwmPeriod) : .4;
    const continuous = result.hz === frame.hz && result.forward === frame.forward;
    result = {
      alpha, beta,
      d: continuous ? result.d + gain * (d - result.d) : d,
      q: continuous ? result.q + gain * (q - result.q) : q,
      hz: frame.hz,
      forward: frame.forward
    };
  }

  function sample(time, motor, uno) {
    const origin = uno.carrierOrigin;
    if (origin === undefined || time < origin || time < nextSample) return;
    nextSample += sampleInterval;
    if (nextSample <= time) nextSample = time + sampleInterval;
    const index = carrierFrame(time, origin);
    // In the Clarke transform the shared neutral of terminals U/V/W cancels.
    const u = motor.getVoltage(0), v = motor.getVoltage(2), w = motor.getVoltage(4);
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
      frame = {index, angle: uno.electricalAngle, hz: uno.running ? uno.hz : 0, forward: uno.forward};
      areaAlpha = areaBeta = duration = 0;
      if (boundarySample) {
        previous = boundarySample;
        integrate(alpha, beta, Math.max(0, time - boundary));
      }
    }
    previous = {time, alpha, beta};
  }

  function read(angle) {
    const {alpha, beta, d, q} = result;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    return {
      raw: {alpha, beta, d: alpha * cosine + beta * sine, q: beta * cosine - alpha * sine},
      filtered: {alpha: d * cosine - q * sine, beta: d * sine + q * cosine, d, q}
    };
  }

  return {reset, sample, read};
}
