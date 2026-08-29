import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getNativeClaudeMemoryDir } from './hooks.js';

describe('native Claude memory path', () => {
  it('derives the Claude project memory directory from the agent cwd', () => {
    assert.equal(
      getNativeClaudeMemoryDir('/home/user/byte-light', '/tmp/claude-config'),
      '/tmp/claude-config/projects/-home-user-byte-light/memory',
    );
  });

  it('keeps sibling projects isolated', () => {
    const root = getNativeClaudeMemoryDir('/home/user/byte-light', '/tmp/claude-config');
    const sibling = getNativeClaudeMemoryDir('/home/user/byte-light-companion-c', '/tmp/claude-config');
    assert.notEqual(root, sibling);
    assert.match(root, /-home-user-byte-light\/memory$/);
    assert.match(sibling, /-home-user-byte-light-companion-c\/memory$/);
  });
});
