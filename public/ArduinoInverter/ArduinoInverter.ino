#include <Arduino.h>
#include <avr/pgmspace.h>

namespace {
constexpr uint16_t frameTicks = 1600;  // 16 MHz / 1600 = 10 kHz.
constexpr uint8_t deadTicks = 64;     // 4 us at 16 MHz.
constexpr uint8_t mergedEdgeTicks = 10;
constexpr uint8_t interleaveTicks = deadTicks + 20; // Includes the port update overhead.
constexpr uint8_t highOutputs = _BV(PD2) | _BV(PD4) | _BV(PD6);
constexpr uint8_t lowOutputs = highOutputs << 1;
constexpr uint8_t allOutputs = highOutputs | lowOutputs;
constexpr uint8_t dirInput = _BV(PB0);  // D8, LOW = reverse
constexpr uint8_t runInput = _BV(PB1);  // D9, LOW = run
constexpr uint8_t dirStatus = _BV(PB2); // D10, HIGH = forward
constexpr uint8_t runStatus = _BV(PB3); // D11, HIGH = PWM enabled
constexpr uint8_t coastMs = 20;
constexpr uint8_t controlFrames = 10;
constexpr uint8_t commandRangeHz = 100;
constexpr uint8_t baseHz = 50;
constexpr uint8_t demoSpeedLimitHz = 75;
constexpr int8_t demoAccelerationHzPerMs = 18;
constexpr int8_t decelerationHzPerMs = 2;
constexpr uint8_t baseActiveScale = 250;

// Q8 samples of sin(0..60 degrees) for the two active-vector dwell times.
const uint8_t sectorSine[] PROGMEM = {
  0, 4, 8, 13, 17, 21, 25, 29, 33, 38, 42, 46, 50,
  54, 58, 62, 66, 70, 74, 78, 82, 86, 90, 94, 98, 102,
  106, 109, 113, 117, 121, 124, 128, 132, 135, 139, 142, 146, 149,
  152, 156, 159, 162, 166, 169, 172, 175, 178, 181, 184, 187, 190,
  192, 195, 198, 201, 203, 206, 208, 211, 213, 215, 217, 220, 222
};

constexpr uint8_t uHigh = _BV(PD2), vHigh = _BV(PD4), wHigh = _BV(PD6);
// Each row is the order of the rising high-side outputs from 000 to 111.
const uint8_t risingOrder[6][3] PROGMEM = {
  {uHigh, vHigh, wHigh},  // 000, 100, 110, 111
  {vHigh, uHigh, wHigh},  // 000, 010, 110, 111
  {vHigh, wHigh, uHigh},  // 000, 010, 011, 111
  {wHigh, vHigh, uHigh},  // 000, 001, 011, 111
  {wHigh, uHigh, vHigh},  // 000, 001, 101, 111
  {uHigh, wHigh, vHigh}   // 000, 100, 101, 111
};

struct Edge {
  uint16_t tick;
  uint8_t high;
};

struct FramePlan {
  uint16_t first, middle, last;
  uint8_t sector;
};

FramePlan nextFrame;
uint16_t frameStart = 0;
uint16_t angle = 0;
uint8_t requestedHz = 0;
uint8_t coast = 0;
uint8_t controlTick = 0;
bool forward = true;
bool overspeedTripped = false;

void blank() {
  PORTD &= uint8_t(~allOutputs);
}

bool enabled() {
  return (PINB & runInput) == 0;
}

inline __attribute__((always_inline)) void waitUntil(uint16_t tick) {
  while (int16_t(TCNT1 - tick) < 0) {}
}

template<bool rising>
inline __attribute__((always_inline)) uint16_t turnOffAt(const Edge& edge) {
  const uint8_t outgoing = rising ? edge.high << 1 : edge.high;
  waitUntil(edge.tick);
  PORTD &= uint8_t(~outgoing);
  return TCNT1 + deadTicks;
}

template<bool rising>
inline __attribute__((always_inline)) void turnOnAt(const Edge& edge, uint16_t ready) {
  const uint8_t incoming = rising ? edge.high : edge.high << 1;
  waitUntil(ready);
  PORTD |= incoming;
}

template<bool rising>
inline __attribute__((always_inline)) void commutatePair(const Edge& first, const Edge& second) {
  const bool interleave = uint16_t(second.tick - first.tick) <= interleaveTicks;
  const uint16_t firstReady = turnOffAt<rising>(first);
  if (!interleave) turnOnAt<rising>(first, firstReady);
  const uint16_t secondReady = turnOffAt<rising>(second);
  if (interleave) turnOnAt<rising>(first, firstReady);
  turnOnAt<rising>(second, secondReady);
}

template<bool rising>
__attribute__((optimize("O3"))) void commutate(const Edge (&edges)[3]) {
  const Edge& first = edges[0];
  const Edge& second = edges[1];
  const Edge& third = edges[2];
  const uint16_t firstGap = second.tick - first.tick;
  const uint16_t secondGap = third.tick - second.tick;

  // Two edges inside the port update latency share a write at their midpoint.
  if (firstGap <= mergedEdgeTicks) {
    const Edge combined = {uint16_t(first.tick + firstGap / 2), uint8_t(first.high | second.high)};
    commutatePair<rising>(combined, third);
    return;
  }
  if (secondGap <= mergedEdgeTicks) {
    const Edge combined = {uint16_t(second.tick + secondGap / 2), uint8_t(second.high | third.high)};
    commutatePair<rising>(first, combined);
    return;
  }

  // Pick the interleaving before the first edge. Each ready time still uses the
  // actual turn-off tick, so a delayed write cannot shorten the dead time.
  const bool secondBeforeFirstOn = firstGap <= interleaveTicks;
  const bool thirdBeforeFirstOn = uint16_t(third.tick - first.tick) <= interleaveTicks;
  const bool thirdBeforeSecondOn = secondGap <= interleaveTicks;

  const uint16_t firstReady = turnOffAt<rising>(first);
  if (!secondBeforeFirstOn) turnOnAt<rising>(first, firstReady);
  const uint16_t secondReady = turnOffAt<rising>(second);
  if (secondBeforeFirstOn && !thirdBeforeFirstOn) turnOnAt<rising>(first, firstReady);
  if (!thirdBeforeSecondOn) turnOnAt<rising>(second, secondReady);
  const uint16_t thirdReady = turnOffAt<rising>(third);
  if (thirdBeforeFirstOn) turnOnAt<rising>(first, firstReady);
  if (thirdBeforeSecondOn) turnOnAt<rising>(second, secondReady);
  turnOnAt<rising>(third, thirdReady);
}

void planFrame(uint8_t hz) {
  const uint16_t advance = (uint16_t(hz) * 419 + 32) >> 6;
  angle = forward ? angle + advance : angle - advance;
  const uint8_t angleIndex = uint8_t((angle + 128U) >> 8);
  const uint16_t position = uint16_t(angleIndex) * 6;
  const uint8_t sector = position >> 8;
  const uint8_t offset = uint8_t(position) >> 2;

  // V/f increases the voltage reference up to 50 Hz and then caps it.
  // t1 and t2 count four-tick groups so the Q8 products stay cheap on AVR.
  const uint8_t scale = hz >= baseHz ? baseActiveScale : hz * (baseActiveScale / baseHz);
  const uint8_t t1 = uint16_t(scale) * pgm_read_byte(&sectorSine[64 - offset]) >> 8;
  const uint8_t t2 = uint16_t(scale) * pgm_read_byte(&sectorSine[offset]) >> 8;
  // Split the zero time equally between 000 at the ends and 111 in the middle.
  const uint16_t first = frameTicks / 4 - t1 - t2;
  nextFrame.first = first;
  nextFrame.middle = first + 2 * ((sector & 1) ? t2 : t1);
  nextFrame.last = first + 2 * (t1 + t2);
  nextFrame.sector = sector;
}

void sampleSetpoint() {
  if ((ADCSRA & _BV(ADSC)) == 0) {
    // Fixed-point equivalent of round(ADC * 100 / 1023) for the 10-bit input.
    const uint16_t scaled = ADC * (commandRangeHz / 4);
    requestedHz = (scaled + 128 + ((scaled + 127) >> 10)) >> 8;
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
  const bool runRequested = enabled();
  if (!runRequested) overspeedTripped = false;
  else if (requestedHz > demoSpeedLimitHz) overspeedTripped = true;
  if (!runRequested || overspeedTripped) {
    if (electricalHz != 0) coast = coastMs;
    electricalHz = 0;
    if (coast != 0) --coast;
    return;
  }
  const bool wantedForward = (PINB & dirInput) != 0;
  if (wantedForward != forward) {
    if (electricalHz > 0) {
      electricalHz = electricalHz > decelerationHzPerMs ? electricalHz - decelerationHzPerMs : 0;
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
  if (requestedHz == electricalHz) return;
  int8_t change = int8_t(requestedHz) - int8_t(electricalHz);
  if (change > demoAccelerationHzPerMs) change = demoAccelerationHzPerMs;
  if (change < -decelerationHzPerMs) change = -decelerationHzPerMs;
  electricalHz = uint8_t(int8_t(electricalHz) + change);
}

void tickControls() {
  if (++controlTick == controlFrames) {
    controlTick = 0;
    serviceControls();
  }
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
  TCCR1B = _BV(CS10);  // Free-running clock, one tick per CPU cycle.
  frameStart = TCNT1 + frameTicks;
}

void loop() {
  if (electricalHz == 0 || !enabled()) {
    blank();
    PORTB &= uint8_t(~runStatus);
    waitUntil(frameStart);
    tickControls();
    if (electricalHz != 0) planFrame(electricalHz);
  } else {
    const uint8_t* order = risingOrder[nextFrame.sector];
    const uint8_t first = pgm_read_byte(order);
    const uint8_t middle = pgm_read_byte(order + 1);
    const uint8_t last = pgm_read_byte(order + 2);
    const Edge rising[] = {
      {uint16_t(frameStart + nextFrame.first), first},
      {uint16_t(frameStart + nextFrame.middle), middle},
      {uint16_t(frameStart + nextFrame.last), last}
    };
    const uint16_t frameEnd = frameStart + frameTicks;
    const Edge falling[] = {
      {uint16_t(frameEnd - nextFrame.last), last},
      {uint16_t(frameEnd - nextFrame.middle), middle},
      {uint16_t(frameEnd - nextFrame.first), first}
    };
    if ((PORTB & runStatus) == 0) {
      waitUntil(frameStart);
      PORTD |= lowOutputs;
      PORTB |= runStatus;
    }
    commutate<true>(rising);
    // Prepare the next frame while the outputs are holding the 111 vector.
    tickControls();
    planFrame(electricalHz);
    commutate<false>(falling);
  }
  frameStart += frameTicks;
}
