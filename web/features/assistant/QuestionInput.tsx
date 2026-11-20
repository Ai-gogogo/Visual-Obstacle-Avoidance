export function QuestionInput() {
  return (
    <details className="assist-details" id="keyboard-input">
      <summary>Keyboard input</summary>
      <form id="question-form">
        <label htmlFor="question">Type a question or command</label>
        <div className="input-row">
          <input
            id="question"
            type="text"
            placeholder="What can you see?"
            maxLength={200}
            required
          />
          <button className="primary">Ask</button>
        </div>
      </form>
      <button type="button" className="quiet" id="discard-voice" hidden>
        Discard transcription
      </button>
    </details>
  );
}
