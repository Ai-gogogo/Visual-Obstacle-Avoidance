export function ReplyPreferences() {
  return (
    <details className="assist-details" id="preferences-panel">
      <summary>Reply and reminder preferences</summary>
      <form id="preferences-form">
        <div className="voice-options">
          <label>
            Reply length
            <select id="reply-length">
              <option value="short">Short</option>
              <option value="detail">More detail</option>
            </select>
          </label>
          <label>
            Reminder when a camera becomes live
            <select id="reminder-habit">
              <option value="">Off</option>
            </select>
          </label>
          <label>
            Minimum time between reminders
            <select id="reminder-interval">
              <option value="0">Each connection</option>
              <option value="15">15 minutes</option>
              <option value="60">1 hour</option>
              <option value="1440">24 hours</option>
            </select>
          </label>
        </div>
        <button type="submit" className="quiet" disabled>
          Save preferences
        </button>
        <p id="preferences-status" role="status"></p>
      </form>
    </details>
  );
}
