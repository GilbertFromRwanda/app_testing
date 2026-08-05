//Can we handle sudden traffic?
// Goal: Test how your system behaves when faced with a sudden surge in traffic
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // Normal traffic
    { duration: '10s', target: 500 },  // 💥 SPIKE! 50x increase
    { duration: '1m', target: 500 },   // Hold at peak
    { duration: '10s', target: 10 },   // Drop back down
    { duration: '30s', target: 10 },   // Recover
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'], // Spikes might be slower
    http_req_failed: ['rate<0.1'],     // But shouldn't fail much
  }
};

export default function() {
  // Simulate high-value transaction (like checkout)
  const orderRes = http.post('https://api.example.com/orders', {
    items: [
      { id: 'prod_123', quantity: 1 },
      { id: 'prod_456', quantity: 2 }
    ],
    shipping: 'express',
    paymentMethod: 'credit_card'
  });
  
  check(orderRes, {
    'order placed': (r) => r.status === 201,
    'confirmation received': (r) => r.json('orderId').length > 0,
  });
  
  // Realistic: users don't spam orders without pause
  sleep(Math.random() * 2 + 0.5);
}