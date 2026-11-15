import test from 'node:test';
import assert from 'node:assert/strict';
import { loginCredential } from '../../dist/packages/database/src/managed-roles.js';

const token = 'a'.repeat(20) + 'b'.repeat(28);
test('login credentials must be dedicated lde_* roles with high-entropy passwords', () => {
  const parsed = loginCredential(`postgresql://lde_app:${token}@db.example.invalid/neondb`, 'lde_runtime');
  assert.equal(parsed.username, 'lde_app'); assert.equal(parsed.base, 'lde_runtime');
  for (const user of ['neondb_owner', 'lde_runtime', 'lde_guard', 'lde_identity', 'LDE_APP']) {
    assert.throws(() => loginCredential(`postgresql://${user}:${token}@db.example.invalid/neondb`, 'lde_runtime'), /dedicated/);
  }
  assert.throws(() => loginCredential('postgresql://lde_app:short@db.example.invalid/neondb', 'lde_runtime'), /high-entropy/);
  assert.throws(() => loginCredential('not a url', 'lde_identity'), /Invalid/);
});
