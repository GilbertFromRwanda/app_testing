// Default config values per test type, mirrored from the original
// smoke/load/stress/spike/soak scripts in this folder.

const presets = {
  smoke: {
    testType: 'smoke',
    description: 'Does it even work? Minimal load (1-2 users) to verify the system is alive.',
    mode: 'constant',
    vus: 1,
    duration: '1m',
    thresholds: { p95: 1000, failRate: 0.01, minRequests: '' },
    sleepMin: 1,
    sleepMax: 1,
  },
  load: {
    testType: 'load',
    description: 'Can we handle normal traffic? Realistic user load, ramping up and down.',
    mode: 'stages',
    stages: [
      { duration: '2m', target: 20 },
      { duration: '5m', target: 100 },
      { duration: '2m', target: 0 },
    ],
    thresholds: { p95: 300, failRate: 0.05, minRequests: 5000 },
    sleepMin: 1,
    sleepMax: 4,
  },
  stress: {
    testType: 'stress',
    description: 'Where do we break? Push well beyond normal capacity.',
    mode: 'stages',
    stages: [
      { duration: '1m', target: 50 },
      { duration: '2m', target: 200 },
      { duration: '2m', target: 500 },
      { duration: '1m', target: 1000 },
      { duration: '3m', target: 0 },
    ],
    thresholds: { p95: '', failRate: 0.5, minRequests: '' },
    sleepMin: 0.5,
    sleepMax: 0.5,
  },
  spike: {
    testType: 'spike',
    description: 'Can we handle sudden traffic? A sharp surge, held, then dropped.',
    mode: 'stages',
    stages: [
      { duration: '30s', target: 10 },
      { duration: '10s', target: 500 },
      { duration: '1m', target: 500 },
      { duration: '10s', target: 10 },
      { duration: '30s', target: 10 },
    ],
    thresholds: { p95: 2000, failRate: 0.1, minRequests: '' },
    sleepMin: 0.5,
    sleepMax: 2.5,
  },
  soak: {
    testType: 'soak',
    description: 'Will it leak memory? Sustained moderate load over a long duration.',
    mode: 'stages',
    stages: [
      { duration: '5m', target: 50 },
      { duration: '4h', target: 50 },
      { duration: '5m', target: 0 },
    ],
    thresholds: { p95: 500, failRate: 0.01, minRequests: 500000 },
    sleepMin: 1,
    sleepMax: 1,
  },
};

module.exports = { presets };
