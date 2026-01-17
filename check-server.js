#!/usr/bin/env node

/**
 * Quick diagnostic script to check backend server and database status
 */

import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, 'objectives.db');

console.log('🔍 Checking backend server status...\n');

// Check if database exists
try {
  const fs = await import('fs');
  const exists = fs.existsSync(DB_PATH);
  console.log(`✅ Database file: ${exists ? 'EXISTS' : 'MISSING'} (${DB_PATH})`);
} catch (error) {
  console.log(`❌ Database file: ERROR - ${error.message}`);
}

// Check database accessibility
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.log(`❌ Database connection: ERROR - ${err.message}`);
  } else {
    console.log('✅ Database connection: OK');
    
    db.get('SELECT COUNT(*) as count FROM objectives', (err, row) => {
      if (err) {
        console.log(`❌ Database query: ERROR - ${err.message}`);
      } else {
        console.log(`✅ Database query: OK (${row.count} objectives found)`);
      }
      
      db.close();
      
      // Check if server is running
      console.log('\n🌐 Checking server...');
      fetch('http://localhost:3001/api/health')
        .then(res => res.json())
        .then(data => {
          console.log(`✅ Server is running: ${data.message}`);
          console.log('\n✅ All checks passed! Your backend should be working.');
        })
        .catch(error => {
          console.log(`❌ Server check failed: ${error.message}`);
          console.log('\n💡 Try starting the server with: cd backend && npm run dev');
        });
    });
  }
});

