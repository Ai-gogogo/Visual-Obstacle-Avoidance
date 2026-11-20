export function VoiceSettings() {
  return (
    <details className="assist-details">
      <summary>Voice controls and settings</summary>
      <p>
        Say “Only look left”, “Use both cameras”, “Switch to Mandarin”, or
        “Export the conversation”.
      </p>
      <button
        type="button"
        className="quiet"
        id="wake-voice"
        aria-pressed="false"
      >
        Enable wake word
      </button>
      <p>
        Say “Hey VisionAssist” or “你好，视觉助手” to start. Wake-word mode uses
        the microphone on this page and transcribes speech locally.
      </p>
      <div className="voice-options">
        <label>
          Camera for visual questions
          <select id="agent-camera" defaultValue="A">
            <option value="both">Both cameras</option>
            <option value="A">Left camera (A)</option>
            <option value="B">Right camera (B)</option>
          </select>
        </label>
        <label>
          Speech language
          <select id="voice-language" defaultValue="system">
            <option value="system">Follow system</option>
            <option value="zh">Mandarin Chinese</option>
            <option value="en">English</option>
            <option value="auto">Auto detect</option>
          </select>
        </label>
        <label className="review-option">
          <input id="review-voice" type="checkbox" /> Review transcription
          before sending
        </label>
      </div>
    </details>
  );
}
