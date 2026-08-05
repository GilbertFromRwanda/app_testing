// Where do we break?
// Goal: Identify the breaking point of your system under extreme load
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 50 },   // Normal load
    { duration: '2m', target: 200 },  // Push hard
    { duration: '2m', target: 500 },  // Beyond capacity
    { duration: '1m', target: 1000 }, // Crush it!
    { duration: '3m', target: 0 },    // Cool down
  ],
  thresholds: {
    // We EXPECT failures, but want to see where they start
    http_req_failed: ['rate<0.5'],    // Under 50% failures
    http_req_duration: ['max<10000'], // Maybe slow, but not timeout
  }
};

export default function() {
  // Heavy operation - maybe search with filters
  const searchRes = http.post('https://api.example.com/search', {
    query: 'laptop',
    filters: { brand: ['dell', 'hp'], price: '500-2000' },
    sort: 'relevance',
    page: Math.floor(Math.random() * 20) + 1
  });
  
  const success = check(searchRes, {
    'search works': (r) => r.status === 200 || r.status === 429,
  });
  
  // If we get rate limited (429), we're hitting limits!
  if (searchRes.status === 429) {
    console.warn('⚠️ Rate limited at iteration', __ITER);
  }
  
  sleep(0.5);
}