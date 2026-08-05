//Can we handle normal traffic?
// Goal: Simulate realistic user behavior under normal load conditions
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

// Load realistic test data
const users = new SharedArray('users', function () {
  return JSON.parse(open('./users.json')); // Array of test users
});

export const options = {
  stages: [
    { duration: '2m', target: 20 },   // Ramp up
    { duration: '5m', target: 100 },  // Stay at peak (100 users)
    { duration: '2m', target: 0 },    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<300'], // 95% under 300ms
    http_req_failed: ['rate<0.05'],   // <5% failure rate
    http_reqs: ['count>5000'],        // At least 5000 requests
  }
};

export default function() {
  // Pick random user
  const user = users[Math.floor(Math.random() * users.length)];
  
  // Simulate user browsing products
  const productsRes = http.get('https://api.example.com/products');
  check(productsRes, {
    'products loaded': (r) => r.status === 200,
  });
  
  // Add item to cart
  const cartRes = http.post('https://api.example.com/cart', {
    productId: 'prod_123',
    quantity: 1,
    userId: user.id
  });
  
  check(cartRes, {
    'added to cart': (r) => r.status === 201,
  });
  
  // Simulate realistic user think time
  sleep(Math.random() * 3 + 1); // 1-4 seconds
}