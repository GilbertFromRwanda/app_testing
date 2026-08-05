//Will it leak memory?

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '5m', target: 50 },   // Warm up
    { duration: '4h', target: 50 },   // ⏰ Run for hours
    { duration: '5m', target: 0 },    // Cool down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // Should stay fast
    http_req_failed: ['rate<0.01'],   // Very few failures
    http_reqs: ['count>500000'],      // At least half a million requests
  }
};

export default function() {
  // Mixed operations to simulate real usage
  const operation = Math.random();
  
  if (operation < 0.3) {
    // Read operation
    const res = http.get('https://api.example.com/dashboard');
    check(res, { 'dashboard loaded': (r) => r.status === 200 });
  } else if (operation < 0.6) {
    // Write operation
    const res = http.post('https://api.example.com/logs', {
      action: 'user_click',
      timestamp: Date.now()
    });
    check(res, { 'log saved': (r) => r.status === 201 });
  } else {
    // Mixed operation
    const res = http.get('https://api.example.com/reports', {
      params: { date: new Date().toISOString().split('T')[0] }
    });
    check(res, { 'report generated': (r) => r.status === 200 });
  }
  
  // Monitor memory usage - watch these in Grafana
  const memUsage = process.memoryUsage();
  console.log(`Heap: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
  
  sleep(1);
}