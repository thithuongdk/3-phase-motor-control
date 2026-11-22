#include <Arduino.h>
#include <avr/pgmspace.h>

namespace {
constexpr uint16_t frameTicks = 1600;  // 16 MHz / 1600 = 10 kHz.
constexpr uint8_t highOutputs = _BV(PD2) | _BV(PD4) | _BV(PD6);
constexpr uint8_t allOutputs = highOutputs | (highOutputs << 1);
constexpr uint8_t dirInput = _BV(PB0);  // D8, LOW = reverse
constexpr uint8_t runInput = _BV(PB1);  // D9, LOW = run
constexpr uint8_t dirStatus = _BV(PB2); // D10, HIGH = forward
constexpr uint8_t runStatus = _BV(PB3); // D11, HIGH = PWM enabled
constexpr uint8_t coastMs = 20;
constexpr uint8_t controlFrames = 10;
constexpr uint8_t maxHz = 50;
constexpr uint16_t firstEdge = 176;
constexpr uint16_t lastEdge = 1360;

const int8_t sineTable[] PROGMEM = {
  0, 3, 6, 9, 12, 16, 19, 22, 25, 28, 31, 34, 37, 40, 43, 46,
  49, 51, 54, 57, 60, 63, 65, 68, 71, 73, 76, 78, 81, 83, 85, 88,
  90, 92, 94, 96, 98, 100, 102, 104, 106, 107, 109, 111, 112, 113, 115, 116,
  117, 118, 120, 121, 122, 122, 123, 124, 125, 125, 126, 126, 126, 127, 127, 127,
  127, 127, 127, 127, 126, 126, 126, 125, 125, 124, 123, 122, 122, 121, 120, 118,
  117, 116, 115, 113, 112, 111, 109, 107, 106, 104, 102, 100, 98, 96, 94, 92,
  90, 88, 85, 83, 81, 78, 76, 73, 71, 68, 65, 63, 60, 57, 54, 51,
  49, 46, 43, 40, 37, 34, 31, 28, 25, 22, 19, 16, 12, 9, 6, 3,
  0, -3, -6, -9, -12, -16, -19, -22, -25, -28, -31, -34, -37, -40, -43, -46,
  -49, -51, -54, -57, -60, -63, -65, -68, -71, -73, -76, -78, -81, -83, -85, -88,
  -90, -92, -94, -96, -98, -100, -102, -104, -106, -107, -109, -111, -112, -113, -115, -116,
  -117, -118, -120, -121, -122, -122, -123, -124, -125, -125, -126, -126, -126, -127, -127, -127,
  -127, -127, -127, -127, -126, -126, -126, -125, -125, -124, -123, -122, -122, -121, -120, -118,
  -117, -116, -115, -113, -112, -111, -109, -107, -106, -104, -102, -100, -98, -96, -94, -92,
  -90, -88, -85, -83, -81, -78, -76, -73, -71, -68, -65, -63, -60, -57, -54, -51,
  -49, -46, -43, -40, -37, -34, -31, -28, -25, -22, -19, -16, -12, -9, -6, -3
};

struct Edge {
  uint16_t tick;
  uint8_t high;
};

uint16_t angle = 0;
uint8_t requestedHz = 0;
uint8_t coast = 0;
uint8_t controlTick = 0;
bool forward = true;

void blank() {
  PORTD &= uint8_t(~allOutputs);
}
bool enabled() {
  return (PINB & runInput) == 0;
}
uint16_t duty(uint16_t phase, uint8_t magnitude) {
  const auto sine = int8_t(pgm_read_byte(&sineTable[phase >> 8]));
  const int16_t ticks = 800 + ((int16_t(sine) * magnitude) >> 4);
  if (ticks < firstEdge) return firstEdge;
  if (ticks > lastEdge) return lastEdge;
  return ticks;
}
void order(Edge& a, Edge& b) {
  if (a.tick > b.tick) {
    Edge swap = a;
    a = b;
    b = swap;
  }
}
void sampleSetpoint() {
  if ((ADCSRA & _BV(ADSC)) == 0) {
    requestedHz = uint8_t((uint32_t(ADC) * maxHz + 511) / 1023);
    if (requestedHz < 5) requestedHz = 0;
    ADCSRA |= _BV(ADSC);
  }
}
}

// Read by the co-simulator as telemetry, independent of waveform generation.
extern "C" {
volatile uint8_t electricalHz = 0;
}

namespace {
void serviceControls() {
  sampleSetpoint();
  if (!enabled()) {
    if (electricalHz != 0) coast = coastMs;
    electricalHz = 0;
    if (coast != 0) --coast;
    return;
  }
  const bool wantedForward = (PINB & dirInput) != 0;
  if (wantedForward != forward) {
    if (electricalHz > 0) {
      electricalHz = electricalHz > 2 ? electricalHz - 2 : 0;
      if (electricalHz == 0) coast = coastMs;
      return;
    }
    if (coast != 0) {
      --coast;
      return;
    }
    forward = wantedForward;
    if (forward) PORTB |= dirStatus;
    else PORTB &= uint8_t(~dirStatus);
  }
  if (coast != 0) {
    --coast;
    return;
  }
  int8_t change = int8_t(requestedHz) - int8_t(electricalHz);
  if (change > 2) change = 2;
  if (change < -2) change = -2;
  electricalHz = uint8_t(int8_t(electricalHz) + change);
}
}

void setup() {
  cli();
  blank();
  DDRD |= allOutputs;
  DDRB |= dirStatus | runStatus;
  PORTB = (PORTB & uint8_t(~runStatus)) | dirInput | runInput | dirStatus;
  ADMUX = _BV(REFS0);  // A0 / AVcc
  ADCSRA = _BV(ADEN) | _BV(ADSC) | _BV(ADPS2) | _BV(ADPS1) | _BV(ADPS0);

  TCCR1A = 0;
  TCCR1B = 0;
  TIMSK1 = 0;
  TCNT1 = 0;
  OCR1A = frameTicks - 1;
  TIFR1 = _BV(OCF1A);
  TCCR1B = _BV(WGM12) | _BV(CS10);
}

void loop() {
  if (++controlTick == controlFrames) {
    controlTick = 0;
    serviceControls();
  }
  const uint8_t hz = electricalHz;
  const uint8_t magnitude = hz >= 50 ? 73 : (uint16_t(hz) * 73 + 25) / 50;
  angle += (uint16_t(hz) * 419 + 32) >> 6;
  const uint16_t phaseV = uint16_t(angle + (forward ? 43691U : 21845U));
  const uint16_t phaseW = uint16_t(angle + (forward ? 21845U : 43691U));
  Edge edges[] = {
    {duty(angle, magnitude), _BV(PD2)},
    {duty(phaseV, magnitude), _BV(PD4)},
    {duty(phaseW, magnitude), _BV(PD6)}
  };
  order(edges[0], edges[1]);
  order(edges[1], edges[2]);
  order(edges[0], edges[1]);

  while ((TIFR1 & _BV(OCF1A)) == 0) {}
  TIFR1 = _BV(OCF1A);
  blank();
  if (hz == 0 || !enabled()) {
    PORTB &= uint8_t(~runStatus);
    return;
  }
  PORTB |= runStatus;
  delayMicroseconds(4);
  PORTD |= highOutputs;

  for (uint8_t i = 0; i < 3;) {
    const uint16_t tick = edges[i].tick;
    while (TCNT1 < tick && (TIFR1 & _BV(OCF1A)) == 0) {}
    if (TIFR1 & _BV(OCF1A)) {
      blank();
      return;
    }
    uint8_t high = edges[i++].high;
    while (i < 3 && edges[i].tick <= tick + 64) high |= edges[i++].high;
    PORTD &= uint8_t(~high);
    delayMicroseconds(4);
    PORTD |= high << 1;
  }
}
