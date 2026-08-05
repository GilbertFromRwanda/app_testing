// Does it even work?
// Goal: Verify your system is alive and responds correctly with minimal load (1-2 users)
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,           // Just 1 user
  duration: '1m',   // Short run
  thresholds: {
    http_req_failed: ['rate<0.01'],  // No failures allowed
    http_req_duration: ['p(95)<1000'], // Quick response
  }
};

export default function() {
  // Test critical user flows
  const loginRes = http.post('https://api.example.com/login', {
    email: 'test@example.com',
    password: 'password123'
  });
  
  check(loginRes, {
    'login successful': (r) => r.status === 200,
    'has auth token': (r) => r.json('token') !== undefined,
  });
  
  const token = loginRes.json('token');
  
  // Get user profile
  const profileRes = http.get('https://api.example.com/profile', {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  check(profileRes, {
    'profile returned': (r) => r.status === 200,
    'username exists': (r) => r.json('username').length > 0,
  });
  
  sleep(1);
}