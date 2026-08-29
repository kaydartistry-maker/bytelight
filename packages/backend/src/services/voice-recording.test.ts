import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// recordingId correlation is the supersede/discard rule for call-mode capture:
// a frame belongs to the active recording when it carries no id (legacy
// clients) or an id matching the one voice_start opened; a stale id from a
// superseded recording is dropped.
const { matchesActiveRecording, MAX_AUDIO_CHUNKS_PER_RECORDING, MAX_AUDIO_BUFFER_SIZE } =
  await import('./voice-recording.js');

describe('matchesActiveRecording (recordingId supersede/discard)', () => {
  it('accepts a frame with no recordingId (legacy client)', () => {
    assert.equal(matchesActiveRecording({ activeRecordingId: 'rec-1' }, undefined), true);
    assert.equal(matchesActiveRecording({ activeRecordingId: null }, undefined), true);
  });

  it('accepts a frame whose id matches the active recording', () => {
    assert.equal(matchesActiveRecording({ activeRecordingId: 'rec-1' }, 'rec-1'), true);
  });

  it('discards a frame from a superseded recording', () => {
    // A newer voice_start set activeRecordingId to rec-2; a late frame tagged
    // rec-1 must be dropped so an older result never lands on the newer turn.
    assert.equal(matchesActiveRecording({ activeRecordingId: 'rec-2' }, 'rec-1'), false);
  });

  it('accepts any string id when no recording is active yet', () => {
    assert.equal(matchesActiveRecording({ activeRecordingId: null }, 'rec-9'), true);
  });

  it('discards a non-string recordingId when one is expected', () => {
    assert.equal(matchesActiveRecording({ activeRecordingId: 'rec-1' }, 42), false);
    assert.equal(matchesActiveRecording({ activeRecordingId: 'rec-1' }, null), false);
  });
});

describe('capture caps', () => {
  it('caps chunks at 3000 per recording', () => {
    assert.equal(MAX_AUDIO_CHUNKS_PER_RECORDING, 3_000);
  });

  it('caps the audio buffer at 25MB', () => {
    assert.equal(MAX_AUDIO_BUFFER_SIZE, 25 * 1024 * 1024);
  });
});
