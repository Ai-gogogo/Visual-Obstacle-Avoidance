export function SavedMemory() {
  return (
    <details id="memory-panel">
      <summary>Saved memory</summary>
      <p>
        Saved records and past observations. Open Judge view for current
        detections.
      </p>
      <p>
        Say “Search memory leaving home” to find related items and habits, or
        “Plan pack my backpack” to start a step-by-step task.
      </p>
      <p>
        Try “Remember, check my keys before going out” or “Register item water
        bottle.” To register a consenting person in view, say “Enroll person”
        followed by their name.
      </p>
      <label htmlFor="memory-kind">Memory type</label>
      <select id="memory-kind">
        <option value="habits">Habits</option>
        <option value="items">Items</option>
        <option value="people">People</option>
      </select>
      <ul id="memory-list"></ul>
      <p id="memory-status" role="status"></p>
    </details>
  );
}
